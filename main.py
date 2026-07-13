# -*- coding: utf-8 -*-
"""Контент-платформа для регионов «Клиники Столицы».
Отдельный веб-сервис: региональные команды находят вирусное, готовят контент под бренд
(с проверкой ст.24), планируют публикации. Общая база Postgres с приложением/ботом.

ENV: DATABASE_URL (обязателен), SECRET_KEY, ANTHROPIC_API_KEY,
     CONTENT_OWNER_EMAIL, CONTENT_OWNER_PASSWORD (создаётся владелец при старте).
"""
import os
import json
import time
import base64
import hmac
import hashlib
import secrets
import datetime as dt

import requests
from fastapi import FastAPI, Request, Response, Depends, HTTPException
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import db

app = FastAPI(title="Контент-платформа КС")

SECRET_KEY = (os.environ.get("SECRET_KEY") or "cp-" + hashlib.sha256(
    (os.environ.get("DATABASE_URL", "local")).encode()).hexdigest())
SESSION_COOKIE = "cp_session"
SESSION_TTL = 30 * 86400
SESSION_SECURE = os.environ.get("SESSION_INSECURE", "") != "1"

REGIONS_SEED = ["Москва", "Астрахань", "Калмыкия", "КБР", "Чечня"]
PLATFORMS = [
    {"key": "vk", "name": "VK", "active": True, "note": ""},
    {"key": "ok", "name": "Одноклассники", "active": True, "note": ""},
    {"key": "instagram", "name": "Instagram", "active": False, "note": "недоступно в РФ"},
    {"key": "tiktok", "name": "TikTok", "active": False, "note": "недоступно в РФ"},
]


# ---------------- Пароли и сессии ----------------
def _scrypt(pw, salt):
    return hashlib.scrypt(str(pw).encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=32)


def hash_password(pw):
    salt = secrets.token_bytes(16)
    return salt.hex(), _scrypt(pw, salt).hex()


def verify_password(pw, salt_hex, hash_hex):
    try:
        return hmac.compare_digest(_scrypt(pw, bytes.fromhex(salt_hex)), bytes.fromhex(hash_hex))
    except Exception:
        return False


def _b64(b):
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _b64d(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def make_session(uid):
    payload = _b64(json.dumps({"uid": uid, "exp": int(time.time()) + SESSION_TTL}).encode())
    sig = _b64(hmac.new(SECRET_KEY.encode(), payload.encode(), hashlib.sha256).digest())
    return payload + "." + sig


def read_session(token):
    if not token or "." not in token:
        return None
    payload, sig = token.rsplit(".", 1)
    good = _b64(hmac.new(SECRET_KEY.encode(), payload.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(sig, good):
        return None
    try:
        data = json.loads(_b64d(payload))
    except Exception:
        return None
    if int(data.get("exp", 0)) < int(time.time()):
        return None
    return data


def set_cookie(resp, uid):
    resp.set_cookie(SESSION_COOKIE, make_session(uid), max_age=SESSION_TTL,
                    httponly=True, secure=SESSION_SECURE, samesite="lax", path="/")


def current_user(request: Request):
    data = read_session(request.cookies.get(SESSION_COOKIE))
    if not data:
        raise HTTPException(401, "Не авторизовано")
    u = db.query_one("SELECT id,email,name,role,region_id FROM cp_users WHERE id=%s", (data["uid"],))
    if not u:
        raise HTTPException(401, "Пользователь не найден")
    return u


def require_owner(request: Request):
    u = current_user(request)
    if u.get("role") != "owner":
        raise HTTPException(403, "Только для владельца")
    return u


def region_for(user, region_id):
    """Менеджер работает только со своим регионом; владелец — с любым (region_id обязателен)."""
    if user["role"] == "owner":
        if not region_id:
            raise HTTPException(400, "Не выбран регион")
        return int(region_id)
    if not user.get("region_id"):
        raise HTTPException(403, "У пользователя не задан регион")
    return int(user["region_id"])


# ---------------- Старт: схема + сиды ----------------
@app.on_event("startup")
def _startup():
    if not db.available():
        print("ВНИМАНИЕ: DATABASE_URL не задан — платформа работать не будет")
        return
    db.init_schema()
    for name in REGIONS_SEED:
        db.execute("INSERT INTO cp_regions(name) VALUES(%s) ON CONFLICT (name) DO NOTHING", (name,))
    oe = os.environ.get("CONTENT_OWNER_EMAIL", "").strip().lower()
    op = os.environ.get("CONTENT_OWNER_PASSWORD", "")
    if oe and op and not db.query_one("SELECT id FROM cp_users WHERE email=%s", (oe,)):
        salt, ph = hash_password(op)
        db.execute("INSERT INTO cp_users(email,name,role,region_id,salt,pass_hash) "
                   "VALUES(%s,%s,'owner',NULL,%s,%s)", (oe, "Владелец", salt, ph))
        print(f"CP: создан владелец {oe}")


# ---------------- Auth ----------------
class LoginIn(BaseModel):
    email: str
    password: str


@app.post("/api/auth/login")
def auth_login(b: LoginIn, response: Response):
    email = (b.email or "").strip().lower()
    u = db.query_one("SELECT id,salt,pass_hash,role,name,region_id FROM cp_users WHERE email=%s", (email,))
    if not u or not verify_password(b.password, u["salt"], u["pass_hash"]):
        raise HTTPException(401, "Неверный email или пароль")
    set_cookie(response, u["id"])
    return {"ok": True, "profile": {"email": email, "name": u["name"], "role": u["role"], "region_id": u["region_id"]}}


@app.get("/api/auth/me")
def auth_me(request: Request):
    try:
        u = current_user(request)
    except HTTPException:
        return {"ok": False}
    return {"ok": True, "profile": {"email": u["email"], "name": u["name"], "role": u["role"], "region_id": u["region_id"]}}


@app.post("/api/auth/logout")
def auth_logout(response: Response):
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


# ---------------- Регионы и площадки ----------------
@app.get("/api/regions")
def regions(user=Depends(current_user)):
    if user["role"] == "owner":
        rows = db.query("SELECT id,name FROM cp_regions ORDER BY name")
    else:
        rows = db.query("SELECT id,name FROM cp_regions WHERE id=%s", (user["region_id"],))
    return {"ok": True, "regions": rows, "role": user["role"], "my_region": user.get("region_id")}


@app.get("/api/platforms")
def platforms(user=Depends(current_user)):
    return {"ok": True, "platforms": PLATFORMS}


# ---------------- Агент «Аналитик вирусности» ----------------
class AnalyzeIn(BaseModel):
    region_id: int | None = None
    url: str = ""
    note: str = ""


def _analyst_prompt(src):
    return (
        "Ты — аналитик вирусного видео-контента для сети МЕДИЦИНСКИХ клиник (клиники, лаборатории, "
        "профосмотры, медкнижки, охрана труда, корпоративная медицина, HR, wellness). "
        "Разбери ролик/пост конкурента и верни СТРОГО JSON без markdown:\n"
        '{"theme":"тема одной фразой","hook":"захват внимания в первые 3 сек","structure":"сценарная структура 1-2 предложения",'
        '"visual":"ключевой визуальный приём","cta":"призыв в оригинале","emotion":"базовая эмоция","why_viral":"почему зашло",'
        '"applicability":[{"direction":"Клиника|Профосмотры|Медкнижки|B2B|HR/охрана труда","idea":"как перенести МЕХАНИКУ (не копию)"}],'
        '"compliance":{"art24_ok":true,"flags":["нарушения ст.24: гарантия результата, обещание излечения, запугивание здорового, обращение к несовершеннолетним, недостоверные медутверждения"],'
        '"needs_erid":false,"needs_erid_reason":"почему реклама/органика","disclaimer":"Имеются противопоказания, необходима консультация специалиста",'
        '"verdict":"можно адаптировать|адаптировать с правками|не подходит бренду"}}\n'
        "Правила: переносим механику, не копируем; для медицины консервативно — любая гарантия/«излечение»/запугивание => art24_ok:false; "
        "рекламный характер => needs_erid:true, инфо-образовательный контент в своём сообществе обычно органика. Коротко, по-русски.\n\nИСТОЧНИК:\n" + src)


@app.post("/api/analyze")
def analyze(b: AnalyzeIn, user=Depends(current_user)):
    rid = region_for(user, b.region_id)
    src = "\n".join(x for x in [(b.url or "").strip(), (b.note or "").strip()] if x)
    if not src:
        return {"ok": False, "error": "Дайте ссылку или описание ролика"}
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not key:
        return {"ok": False, "error": "ANTHROPIC_API_KEY не задан на сервере"}
    body = {"model": os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-6"), "max_tokens": 1600,
            "messages": [{"role": "user", "content": _analyst_prompt(src)}]}
    try:
        r = requests.post("https://api.anthropic.com/v1/messages",
                          headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
                          json=body, timeout=90)
        if r.status_code != 200:
            return {"ok": False, "error": f"claude {r.status_code}"}
        raw = "".join(p.get("text", "") for p in r.json().get("content", []) if p.get("type") == "text")
        card = json.loads(raw.replace("```json", "").replace("```", "").strip())
    except Exception as e:
        return {"ok": False, "error": str(e)[:140]}
    row = db.query_one("INSERT INTO cp_ideas(region_id,source_url,data,status) VALUES(%s,%s,%s,'new') RETURNING id,created_at",
                       (rid, (b.url or "").strip(), db.jval(card)))
    return {"ok": True, "id": row["id"], "card": card}


@app.get("/api/ideas")
def ideas(region_id: int | None = None, user=Depends(current_user)):
    rid = region_for(user, region_id)
    rows = db.query("SELECT id,source_url,data,status,created_at FROM cp_ideas WHERE region_id=%s ORDER BY id DESC LIMIT 200", (rid,))
    return {"ok": True, "ideas": rows}


class IdIn(BaseModel):
    id: int


@app.post("/api/ideas/delete")
def ideas_delete(b: IdIn, user=Depends(current_user)):
    rid = user.get("region_id")
    if user["role"] == "owner":
        db.execute("DELETE FROM cp_ideas WHERE id=%s", (b.id,))
    else:
        db.execute("DELETE FROM cp_ideas WHERE id=%s AND region_id=%s", (b.id, rid))
    return {"ok": True}


# ---------------- Контент-план ----------------
class PlanIn(BaseModel):
    region_id: int | None = None
    title: str = ""
    text: str = ""
    platforms: list = []
    date: str = ""
    time: str = ""
    status: str = "draft"
    idea_id: int | None = None
    compliance: dict | None = None


@app.post("/api/plan/add")
def plan_add(b: PlanIn, user=Depends(current_user)):
    rid = region_for(user, b.region_id)
    plats = [p for p in (b.platforms or []) if isinstance(p, str)]
    d = None
    try:
        d = dt.date.fromisoformat(b.date) if b.date else None
    except Exception:
        d = None
    row = db.query_one(
        "INSERT INTO cp_plan(region_id,title,text,platforms,plan_date,plan_time,status,idea_id,compliance) "
        "VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",
        (rid, b.title[:200], b.text, plats, d, (b.time or "")[:5], b.status, b.idea_id, db.jval(b.compliance or {})))
    return {"ok": True, "id": row["id"]}


@app.get("/api/plan")
def plan_list(region_id: int | None = None, user=Depends(current_user)):
    rid = region_for(user, region_id)
    rows = db.query("SELECT id,title,text,platforms,plan_date,plan_time,status,idea_id,created_at "
                    "FROM cp_plan WHERE region_id=%s ORDER BY plan_date NULLS LAST, plan_time", (rid,))
    for r in rows:
        r["plan_date"] = r["plan_date"].isoformat() if r.get("plan_date") else ""
    return {"ok": True, "plan": rows}


class PlanStatus(BaseModel):
    id: int
    status: str


@app.post("/api/plan/status")
def plan_status(b: PlanStatus, user=Depends(current_user)):
    if b.status not in ("draft", "ready", "published"):
        return {"ok": False, "error": "bad status"}
    if user["role"] == "owner":
        db.execute("UPDATE cp_plan SET status=%s WHERE id=%s", (b.status, b.id))
    else:
        db.execute("UPDATE cp_plan SET status=%s WHERE id=%s AND region_id=%s", (b.status, b.id, user["region_id"]))
    return {"ok": True}


@app.post("/api/plan/delete")
def plan_delete(b: IdIn, user=Depends(current_user)):
    if user["role"] == "owner":
        db.execute("DELETE FROM cp_plan WHERE id=%s", (b.id,))
    else:
        db.execute("DELETE FROM cp_plan WHERE id=%s AND region_id=%s", (b.id, user["region_id"]))
    return {"ok": True}


# ---------------- Управление менеджерами (владелец) ----------------
class UserIn(BaseModel):
    email: str
    password: str
    name: str = ""
    region_id: int


@app.post("/api/users/add")
def users_add(b: UserIn, user=Depends(require_owner)):
    email = (b.email or "").strip().lower()
    if not email or not b.password:
        return {"ok": False, "error": "email и пароль обязательны"}
    if db.query_one("SELECT id FROM cp_users WHERE email=%s", (email,)):
        return {"ok": False, "error": "email уже есть"}
    salt, ph = hash_password(b.password)
    db.execute("INSERT INTO cp_users(email,name,role,region_id,salt,pass_hash) VALUES(%s,%s,'manager',%s,%s,%s)",
               (email, b.name[:80], int(b.region_id), salt, ph))
    return {"ok": True}


@app.get("/api/users")
def users_list(user=Depends(require_owner)):
    rows = db.query("SELECT u.id,u.email,u.name,u.role,r.name AS region FROM cp_users u "
                    "LEFT JOIN cp_regions r ON r.id=u.region_id ORDER BY u.role,u.email")
    return {"ok": True, "users": rows}


# ---------------- Статика (веб-интерфейс) ----------------
app.mount("/", StaticFiles(directory=os.path.join(os.path.dirname(os.path.abspath(__file__)), "web"), html=True), name="web")

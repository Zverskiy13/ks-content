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
import threading
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


def _analyst_card(src):
    """Возвращает (card|None, error|None). Зовёт Claude по тексту/ссылке ролика."""
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not key:
        return None, "ANTHROPIC_API_KEY не задан на сервере"
    body = {"model": os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-6"), "max_tokens": 1600,
            "messages": [{"role": "user", "content": _analyst_prompt(src)}]}
    try:
        r = requests.post("https://api.anthropic.com/v1/messages",
                          headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
                          json=body, timeout=90)
        if r.status_code != 200:
            return None, f"claude {r.status_code}"
        raw = "".join(p.get("text", "") for p in r.json().get("content", []) if p.get("type") == "text")
        return json.loads(raw.replace("```json", "").replace("```", "").strip()), None
    except Exception as e:
        return None, str(e)[:140]


@app.post("/api/analyze")
def analyze(b: AnalyzeIn, user=Depends(current_user)):
    rid = region_for(user, b.region_id)
    src = "\n".join(x for x in [(b.url or "").strip(), (b.note or "").strip()] if x)
    if not src:
        return {"ok": False, "error": "Дайте ссылку или описание ролика"}
    card, err = _analyst_card(src)
    if err:
        return {"ok": False, "error": err}
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
    rows = db.query("SELECT id,title,text,platforms,plan_date,plan_time,status,idea_id,created_at,published_url,publish_error "
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


# ================= АГЕНТ-РАЗВЕДЧИК VK (v2) =================
VK_API = "https://api.vk.com/method/"
VK_V = "5.199"


def _vk_token():
    return os.environ.get("VK_SERVICE_TOKEN", "")


def _vk_call(method, **params):
    params.update({"access_token": _vk_token(), "v": VK_V})
    r = requests.get(VK_API + method, params=params, timeout=30)
    j = r.json()
    if "error" in j:
        raise RuntimeError(j["error"].get("error_msg", "VK error"))
    return j.get("response")


def _vk_screen(url):
    u = (url or "").strip().rstrip("/").split("?")[0]
    if "vk.com/" in u:
        u = u.split("vk.com/")[-1]
    return u.lstrip("@")


def _vk_group(screen):
    """(gid, members, name) сообщества по короткому имени/ID."""
    resp = _vk_call("groups.getById", group_id=screen, fields="members_count")
    grp = None
    if isinstance(resp, dict) and resp.get("groups"):
        grp = resp["groups"][0]
    elif isinstance(resp, list) and resp:
        grp = resp[0]
    if not grp:
        raise RuntimeError("сообщество не найдено")
    return grp["id"], int(grp.get("members_count") or 0), grp.get("name", "")


def _vk_collect(url):
    gid, members, gname = _vk_group(_vk_screen(url))
    wall = _vk_call("wall.get", owner_id=-gid, count=40, filter="owner")
    out = []
    for it in (wall.get("items", []) if isinstance(wall, dict) else []):
        atts = it.get("attachments", []) or []
        if not any(a.get("type") == "video" for a in atts):
            continue
        likes = (it.get("likes") or {}).get("count", 0)
        reposts = (it.get("reposts") or {}).get("count", 0)
        comments = (it.get("comments") or {}).get("count", 0)
        views = (it.get("views") or {}).get("count", 0)
        er = round((likes + reposts + comments) / max(members, 1) * 100, 3)
        out.append({"post_url": f"https://vk.com/wall{it['owner_id']}_{it['id']}", "source_name": gname,
                    "text": (it.get("text") or "")[:1000], "likes": likes, "reposts": reposts,
                    "views": views, "comments": comments, "er": er,
                    "pdate": dt.datetime.fromtimestamp(it.get("date", 0), dt.timezone.utc) if it.get("date") else None})
    return out


# ---- YouTube (официальный Data API v3, ключ YOUTUBE_API_KEY) ----
YT = "https://www.googleapis.com/youtube/v3/"


def _yt_key():
    return os.environ.get("YOUTUBE_API_KEY", "")


def _yt_get(path, **params):
    params["key"] = _yt_key()
    r = requests.get(YT + path, params=params, timeout=30)
    return r.json()


def _yt_channel_id(url):
    u = (url or "").strip().rstrip("/").split("?")[0]
    if "/channel/" in u:
        return u.split("/channel/")[-1].split("/")[0]
    seg = u.split("youtube.com/")[-1] if "youtube.com/" in u else u
    seg = seg.split("/")[0]
    if seg.startswith("UC"):
        return seg
    handle = seg if seg.startswith("@") else "@" + seg
    j = _yt_get("channels", part="id", forHandle=handle)
    if j.get("items"):
        return j["items"][0]["id"]
    j = _yt_get("search", part="snippet", q=seg.lstrip("@"), type="channel", maxResults=1)
    if j.get("items"):
        return j["items"][0]["snippet"]["channelId"]
    raise RuntimeError("канал YouTube не найден")


def _yt_collect(url):
    cid = _yt_channel_id(url)
    s = _yt_get("search", part="id", channelId=cid, order="date", type="video", maxResults=25)
    ids = [it["id"]["videoId"] for it in s.get("items", []) if it.get("id", {}).get("videoId")]
    if not ids:
        return []
    v = _yt_get("videos", part="statistics,snippet", id=",".join(ids))
    out = []
    for it in v.get("items", []):
        st, sn = it.get("statistics", {}), it.get("snippet", {})
        views = int(st.get("viewCount", 0) or 0)
        likes = int(st.get("likeCount", 0) or 0)
        comments = int(st.get("commentCount", 0) or 0)
        er = round((likes + comments) / max(views, 1) * 100, 3)
        out.append({"post_url": f"https://youtube.com/watch?v={it['id']}", "source_name": sn.get("channelTitle", ""),
                    "text": sn.get("title", ""), "likes": likes, "reposts": 0, "views": views,
                    "comments": comments, "er": er, "pdate": sn.get("publishedAt")})
    return out


# Площадки разведки. auto=True — есть авто-сбор; иначе добавляем ссылки на ролики вручную.
SCOUT_PLATFORMS = [
    {"key": "vk", "name": "VK", "auto": True},
    {"key": "youtube", "name": "YouTube", "auto": True},
    {"key": "telegram", "name": "Telegram", "auto": False},
    {"key": "ok", "name": "Одноклассники", "auto": False},
    {"key": "instagram", "name": "Instagram", "auto": False},
    {"key": "tiktok", "name": "TikTok", "auto": False},
    {"key": "other", "name": "Другое", "auto": False},
]
_COLLECTORS = {"vk": _vk_collect, "youtube": _yt_collect}


def _scout_save(rid, source_id, platform, it):
    pdate = it.get("pdate")
    if isinstance(pdate, str):
        try:
            pdate = dt.datetime.fromisoformat(pdate.replace("Z", "+00:00"))
        except Exception:
            pdate = None
    db.execute(
        "INSERT INTO cp_scout(region_id,source_id,platform,post_url,source_name,text,likes,reposts,views,comments,er,post_date) "
        "VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (region_id,post_url) DO UPDATE SET "
        "likes=EXCLUDED.likes,reposts=EXCLUDED.reposts,views=EXCLUDED.views,comments=EXCLUDED.comments,er=EXCLUDED.er",
        (rid, source_id, platform, it["post_url"], it.get("source_name", ""), it.get("text", ""),
         it.get("likes", 0), it.get("reposts", 0), it.get("views", 0), it.get("comments", 0), it.get("er", 0), pdate))


@app.get("/api/scout/platforms")
def scout_platforms(user=Depends(current_user)):
    keys = {"vk": bool(_vk_token()), "youtube": bool(_yt_key())}
    return {"ok": True, "platforms": SCOUT_PLATFORMS, "ready": keys}


class SourceIn(BaseModel):
    region_id: int | None = None
    url: str
    platform: str = "vk"


@app.post("/api/sources/add")
def sources_add(b: SourceIn, user=Depends(current_user)):
    rid = region_for(user, b.region_id)
    name = ""
    if b.platform == "vk" and _vk_token():
        try:
            _, _, name = _vk_group(_vk_screen(b.url))
        except Exception:
            name = ""
    db.execute("INSERT INTO cp_sources(region_id,platform,url,name) VALUES(%s,%s,%s,%s)",
               (rid, b.platform, b.url.strip(), name))
    return {"ok": True, "name": name}


@app.get("/api/sources")
def sources_list(region_id: int | None = None, user=Depends(current_user)):
    rid = region_for(user, region_id)
    rows = db.query("SELECT id,platform,url,name,added_at FROM cp_sources WHERE region_id=%s ORDER BY id", (rid,))
    return {"ok": True, "sources": rows, "vk_ready": bool(_vk_token())}


@app.post("/api/sources/delete")
def sources_delete(b: IdIn, user=Depends(current_user)):
    if user["role"] == "owner":
        db.execute("DELETE FROM cp_sources WHERE id=%s", (b.id,))
    else:
        db.execute("DELETE FROM cp_sources WHERE id=%s AND region_id=%s", (b.id, user["region_id"]))
    return {"ok": True}


class ScoutRun(BaseModel):
    region_id: int | None = None


@app.post("/api/scout/run")
def scout_run(b: ScoutRun, user=Depends(current_user)):
    rid = region_for(user, b.region_id)
    sources = db.query("SELECT id,url,platform,name FROM cp_sources WHERE region_id=%s", (rid,))
    if not sources:
        return {"ok": False, "error": "Добавьте хотя бы один источник"}
    found, errors, skipped = 0, [], set()
    for s in sources:
        plat = s["platform"]
        col = _COLLECTORS.get(plat)
        if not col:
            skipped.add(plat)
            continue
        if plat == "vk" and not _vk_token():
            skipped.add("vk (нет VK_SERVICE_TOKEN)")
            continue
        if plat == "youtube" and not _yt_key():
            skipped.add("youtube (нет YOUTUBE_API_KEY)")
            continue
        try:
            for it in col(s["url"]):
                try:
                    _scout_save(rid, s["id"], plat, it)
                    found += 1
                except Exception:
                    pass
        except Exception as e:
            errors.append(f"{s.get('name') or s['url']}: {str(e)[:80]}")
    return {"ok": True, "found": found, "errors": errors, "skipped": sorted(skipped)}


@app.get("/api/scout")
def scout_list(region_id: int | None = None, user=Depends(current_user)):
    rid = region_for(user, region_id)
    rows = db.query("SELECT id,platform,post_url,source_name,text,likes,reposts,views,comments,er,post_date,analyzed "
                    "FROM cp_scout WHERE region_id=%s ORDER BY er DESC, id DESC LIMIT 100", (rid,))
    for r in rows:
        r["post_date"] = r["post_date"].isoformat()[:10] if r.get("post_date") else ""
    return {"ok": True, "scout": rows}


@app.post("/api/scout/analyze")
def scout_analyze(b: IdIn, user=Depends(current_user)):
    row = db.query_one("SELECT * FROM cp_scout WHERE id=%s", (b.id,))
    if not row:
        return {"ok": False, "error": "не найдено"}
    if user["role"] != "owner" and row["region_id"] != user.get("region_id"):
        raise HTTPException(403, "чужой регион")
    src = f"{row['post_url']}\nСообщество: {row['source_name']}\nМетрики: лайки {row['likes']}, репосты {row['reposts']}, комментарии {row['comments']}, ER {row['er']}%\nТекст: {row['text']}"
    card, err = _analyst_card(src)
    if err:
        return {"ok": False, "error": err}
    db.execute("INSERT INTO cp_ideas(region_id,source_url,data,status) VALUES(%s,%s,%s,'new')",
               (row["region_id"], row["post_url"], db.jval(card)))
    db.execute("UPDATE cp_scout SET analyzed=true WHERE id=%s", (b.id,))
    return {"ok": True, "card": card}


@app.post("/api/scout/delete")
def scout_delete(b: IdIn, user=Depends(current_user)):
    if user["role"] == "owner":
        db.execute("DELETE FROM cp_scout WHERE id=%s", (b.id,))
    else:
        db.execute("DELETE FROM cp_scout WHERE id=%s AND region_id=%s", (b.id, user["region_id"]))
    return {"ok": True}


# ================= ПОДКЛЮЧЕНИЕ СОЦСЕТЕЙ + АВТОПОСТИНГ (v2.2) =================
class SocialIn(BaseModel):
    region_id: int | None = None
    platform: str
    token: str = ""
    group_id: str = ""


@app.post("/api/social/connect")
def social_connect(b: SocialIn, user=Depends(current_user)):
    rid = region_for(user, b.region_id)
    if b.platform not in ("vk", "ok"):
        return {"ok": False, "error": "Автопостинг пока только VK и OK"}
    db.execute("INSERT INTO cp_social(region_id,platform,token,group_id) VALUES(%s,%s,%s,%s) "
               "ON CONFLICT (region_id,platform) DO UPDATE SET token=EXCLUDED.token,group_id=EXCLUDED.group_id,updated_at=now()",
               (rid, b.platform, b.token.strip(), b.group_id.strip()))
    return {"ok": True}


@app.get("/api/social")
def social_list(region_id: int | None = None, user=Depends(current_user)):
    rid = region_for(user, region_id)
    rows = db.query("SELECT platform,group_id,updated_at FROM cp_social WHERE region_id=%s", (rid,))
    return {"ok": True, "social": rows}  # токены не отдаём


class SocialPlat(BaseModel):
    region_id: int | None = None
    platform: str


@app.post("/api/social/disconnect")
def social_disconnect(b: SocialPlat, user=Depends(current_user)):
    rid = region_for(user, b.region_id)
    db.execute("DELETE FROM cp_social WHERE region_id=%s AND platform=%s", (rid, b.platform))
    return {"ok": True}


def _post_text(row):
    t = (row.get("title") or "").strip()
    body = (row.get("text") or "").strip()
    return (t + "\n\n" + body).strip() if body else t


def _vk_publish(token, group_id, text):
    gid = str(group_id).lstrip("-").strip()
    if not gid:
        raise RuntimeError("не указан ID сообщества VK")
    r = requests.get(VK_API + "wall.post", params={
        "owner_id": f"-{gid}", "from_group": 1, "message": text, "access_token": token, "v": VK_V}, timeout=30).json()
    if "error" in r:
        raise RuntimeError(r["error"].get("error_msg", "VK error"))
    pid = r.get("response", {}).get("post_id")
    return f"https://vk.com/wall-{gid}_{pid}"


def _ok_publish(token, gid, text):
    app_key = os.environ.get("OK_APP_KEY", "")
    app_secret = os.environ.get("OK_APP_SECRET", "")
    if not (app_key and app_secret and token and gid):
        raise RuntimeError("OK не настроен: нужны OK_APP_KEY, OK_APP_SECRET, токен и ID группы")
    attachment = json.dumps({"media": [{"type": "text", "text": text}]}, ensure_ascii=False)
    params = {"application_key": app_key, "format": "json", "gid": str(gid),
              "method": "mediatopic.post", "type": "GROUP_THEME", "attachment": attachment}
    base = "".join(f"{k}={params[k]}" for k in sorted(params))
    secret = hashlib.md5((token + app_secret).encode("utf-8")).hexdigest()
    sig = hashlib.md5((base + secret).encode("utf-8")).hexdigest()
    r = requests.get("https://api.ok.ru/fb.do", params={**params, "access_token": token, "sig": sig}, timeout=30).json()
    if isinstance(r, dict) and r.get("error_code"):
        raise RuntimeError(f"OK: {r.get('error_msg', 'error')}")
    return "https://ok.ru/group/" + str(gid)


def _publish_row(row):
    """Публикует запись плана в её площадки. Возвращает (url|'', error|'')."""
    urls, errs = [], []
    text = _post_text(row)
    for plat in (row.get("platforms") or []):
        acc = db.query_one("SELECT token,group_id FROM cp_social WHERE region_id=%s AND platform=%s",
                           (row["region_id"], plat))
        if not acc or not acc.get("token"):
            errs.append(f"{plat}: не подключён")
            continue
        try:
            if plat == "vk":
                urls.append(_vk_publish(acc["token"], acc["group_id"], text))
            elif plat == "ok":
                urls.append(_ok_publish(acc["token"], acc["group_id"], text))
            else:
                errs.append(f"{plat}: автопостинг не поддержан")
        except Exception as e:
            errs.append(f"{plat}: {str(e)[:110]}")
    return (urls[0] if urls else ""), ("; ".join(errs) if errs else "")


@app.post("/api/plan/publish")
def plan_publish(b: IdIn, user=Depends(current_user)):
    row = db.query_one("SELECT * FROM cp_plan WHERE id=%s", (b.id,))
    if not row:
        return {"ok": False, "error": "не найдено"}
    if user["role"] != "owner" and row["region_id"] != user.get("region_id"):
        raise HTTPException(403, "чужой регион")
    url, err = _publish_row(row)
    if url:
        db.execute("UPDATE cp_plan SET status='published',published_url=%s,publish_error=%s,published_at=now() WHERE id=%s",
                   (url, err, b.id))
        return {"ok": True, "url": url, "error": err}
    db.execute("UPDATE cp_plan SET publish_error=%s WHERE id=%s", (err or "не удалось", b.id))
    return {"ok": False, "error": err or "не удалось"}


def _due_publish():
    now = dt.datetime.now(dt.timezone(dt.timedelta(hours=3))).replace(tzinfo=None)  # МСК
    rows = db.query("SELECT * FROM cp_plan WHERE status='ready' AND plan_date IS NOT NULL")
    for row in rows:
        pt = (row.get("plan_time") or "00:00")
        try:
            hh, mm = (pt.split(":") + ["0"])[:2]
            due = dt.datetime.combine(row["plan_date"], dt.time(int(hh), int(mm)))
        except Exception:
            continue
        if due > now:
            continue
        url, err = _publish_row(row)
        if url:
            db.execute("UPDATE cp_plan SET status='published',published_url=%s,publish_error=%s,published_at=now() WHERE id=%s",
                       (url, err, row["id"]))
        else:
            db.execute("UPDATE cp_plan SET publish_error=%s WHERE id=%s", (err or "не удалось", row["id"]))


def _scheduler_loop():
    while True:
        try:
            if db.available():
                _due_publish()
        except Exception as e:
            print("scheduler:", e)
        time.sleep(60)


threading.Thread(target=_scheduler_loop, daemon=True).start()


# ---------------- Статика (веб-интерфейс) ----------------
app.mount("/", StaticFiles(directory=os.path.join(os.path.dirname(os.path.abspath(__file__)), "web"), html=True), name="web")

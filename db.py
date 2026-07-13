# -*- coding: utf-8 -*-
"""Слой Postgres для контент-платформы регионов. Общая база с приложением/ботом,
свои таблицы (regions, region_users, ideas, plan). Если DATABASE_URL/psycopg нет —
падаем с понятной ошибкой (для этого сервиса база обязательна)."""
import os

try:
    import psycopg
    from psycopg.types.json import Json
except Exception:
    psycopg = None
    Json = None

DATABASE_URL = os.environ.get("DATABASE_URL", "")


def available():
    return bool(DATABASE_URL and psycopg)


def _dsn():
    d = DATABASE_URL
    if d.startswith("postgres://"):
        d = "postgresql://" + d[len("postgres://"):]
    return d


def _conn():
    return psycopg.connect(_dsn(), connect_timeout=10)


def execute(sql, params=None):
    with _conn() as c:
        with c.cursor() as cur:
            cur.execute(sql, params or ())
        c.commit()


def query(sql, params=None):
    with _conn() as c:
        with c.cursor() as cur:
            cur.execute(sql, params or ())
            if not cur.description:
                return []
            cols = [d[0] for d in cur.description]
            return [dict(zip(cols, r)) for r in cur.fetchall()]


def query_one(sql, params=None):
    rows = query(sql, params)
    return rows[0] if rows else None


def jval(obj):
    """Обернуть dict/list для jsonb-параметра."""
    return Json(obj) if Json else obj


DDL = """
CREATE TABLE IF NOT EXISTS cp_regions (
    id      bigserial PRIMARY KEY,
    name    text UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS cp_users (
    id         bigserial PRIMARY KEY,
    email      text UNIQUE NOT NULL,
    name       text NOT NULL DEFAULT '',
    role       text NOT NULL DEFAULT 'manager',   -- owner | manager
    region_id  bigint REFERENCES cp_regions(id),
    salt       text NOT NULL,
    pass_hash  text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cp_ideas (
    id         bigserial PRIMARY KEY,
    region_id  bigint REFERENCES cp_regions(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    source_url text NOT NULL DEFAULT '',
    data       jsonb NOT NULL,
    status     text NOT NULL DEFAULT 'new'
);
CREATE TABLE IF NOT EXISTS cp_plan (
    id         bigserial PRIMARY KEY,
    region_id  bigint REFERENCES cp_regions(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    title      text NOT NULL DEFAULT '',
    text       text NOT NULL DEFAULT '',
    platforms  text[] NOT NULL DEFAULT '{}',
    plan_date  date,
    plan_time  text NOT NULL DEFAULT '',
    status     text NOT NULL DEFAULT 'draft',      -- draft | ready | published
    idea_id    bigint,
    compliance jsonb
);
CREATE TABLE IF NOT EXISTS cp_sources (
    id         bigserial PRIMARY KEY,
    region_id  bigint REFERENCES cp_regions(id),
    platform   text NOT NULL DEFAULT 'vk',
    url        text NOT NULL,
    name       text NOT NULL DEFAULT '',
    added_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cp_scout (
    id          bigserial PRIMARY KEY,
    region_id   bigint REFERENCES cp_regions(id),
    source_id   bigint,
    platform    text NOT NULL DEFAULT 'vk',
    post_url    text NOT NULL DEFAULT '',
    source_name text NOT NULL DEFAULT '',
    text        text NOT NULL DEFAULT '',
    likes       int NOT NULL DEFAULT 0,
    reposts     int NOT NULL DEFAULT 0,
    views       int NOT NULL DEFAULT 0,
    comments    int NOT NULL DEFAULT 0,
    er          double precision NOT NULL DEFAULT 0,
    post_date   timestamptz,
    collected_at timestamptz NOT NULL DEFAULT now(),
    analyzed    boolean NOT NULL DEFAULT false,
    UNIQUE (region_id, post_url)
);
CREATE TABLE IF NOT EXISTS cp_social (
    id         bigserial PRIMARY KEY,
    region_id  bigint REFERENCES cp_regions(id),
    platform   text NOT NULL,
    token      text NOT NULL DEFAULT '',
    group_id   text NOT NULL DEFAULT '',
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (region_id, platform)
);
ALTER TABLE cp_plan ADD COLUMN IF NOT EXISTS published_url text;
ALTER TABLE cp_plan ADD COLUMN IF NOT EXISTS publish_error text;
ALTER TABLE cp_plan ADD COLUMN IF NOT EXISTS published_at timestamptz;
CREATE INDEX IF NOT EXISTS cp_ideas_region ON cp_ideas(region_id);
CREATE INDEX IF NOT EXISTS cp_plan_region ON cp_plan(region_id);
CREATE INDEX IF NOT EXISTS cp_sources_region ON cp_sources(region_id);
CREATE INDEX IF NOT EXISTS cp_scout_region ON cp_scout(region_id);
"""


def init_schema():
    with _conn() as c:
        with c.cursor() as cur:
            cur.execute(DDL)
        c.commit()

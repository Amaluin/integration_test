import type { Db } from '../shared/db';

export function initHubSchema(db: Db) {
  db.exec(`
    -- журнал принятых событий: по id узнаём повторную доставку
    create table if not exists inbox (
      event_id          text primary key,
      source            text not null,
      type              text not null,
      aggregate_id      text not null,
      aggregate_version integer not null,
      received_at       text not null
    );

    -- последняя применённая версия каждого объекта: запоздавшее событие не откатит статус
    create table if not exists aggregate_versions (
      key     text primary key,
      version integer not null
    );

    create table if not exists flows (
      flow_id        text primary key,
      need_id        text not null unique,
      need_version   integer not null,
      project_id     text not null,
      status         text not null,
      review_id      text,
      procurement_id text,
      need_json      text not null,
      approved_json  text,
      created_at     text not null,
      updated_at     text not null
    );

    create table if not exists flow_history (
      id      integer primary key autoincrement,
      flow_id text not null,
      at      text not null,
      message text not null
    );

    -- очередь исходящих команд; idempotency_key уникален, повторная постановка невозможна
    create table if not exists commands (
      id              integer primary key autoincrement,
      flow_id         text not null,
      type            text not null,
      target          text not null,
      idempotency_key text not null unique,
      payload         text not null,
      status          text not null default 'pending',
      attempts        integer not null default 0,
      next_attempt_at integer not null,
      last_error      text,
      created_at      text not null
    );
  `);
}

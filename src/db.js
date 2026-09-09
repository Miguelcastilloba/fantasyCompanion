import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export class Store {
  constructor(filename = ":memory:") {
    if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_key TEXT NOT NULL UNIQUE,
        job_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        available_at TEXT NOT NULL,
        lease_until TEXT,
        worker_id TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS jobs_due_idx ON jobs(status, available_at, lease_until);
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        collected_at TEXT NOT NULL,
        state_hash TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reports (
        report_id TEXT PRIMARY KEY,
        league_id INTEGER NOT NULL,
        team_id INTEGER NOT NULL,
        season INTEGER NOT NULL,
        scoring_period_id INTEGER,
        sequence INTEGER NOT NULL,
        state_hash TEXT,
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(league_id, team_id, season, scoring_period_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS reports_latest_idx ON reports(league_id, team_id, season, scoring_period_id, sequence DESC);
      CREATE TABLE IF NOT EXISTS deliveries (
        report_id TEXT PRIMARY KEY REFERENCES reports(report_id),
        status TEXT NOT NULL,
        transport TEXT NOT NULL,
        provider_reference TEXT,
        error TEXT,
        updated_at TEXT NOT NULL,
        sent_at TEXT
      );
    `);
  }

  close() { this.db.close(); }

  enqueueJob({ jobKey, jobType, payload = {}, availableAt }) {
    const now = new Date().toISOString();
    const result = this.db.prepare(`INSERT OR IGNORE INTO jobs(job_key, job_type, payload_json, available_at, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)`).run(jobKey, jobType, JSON.stringify(payload), availableAt || now, now, now);
    return { inserted: result.changes === 1, jobKey };
  }

  leaseNextJob({ workerId, now = new Date().toISOString(), leaseSeconds = 900 } = {}) {
    const leaseUntil = new Date(Date.parse(now) + leaseSeconds * 1000).toISOString();
    const tx = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM jobs WHERE (status = 'queued' AND available_at <= ?) OR (status = 'running' AND lease_until < ?) ORDER BY CASE job_type WHEN 'inactive_watch' THEN 1 WHEN 'pregame_coach' THEN 2 WHEN 'waiver_planner' THEN 3 ELSE 5 END, available_at, id LIMIT 1`).get(now, now);
      if (!row) return null;
      this.db.prepare(`UPDATE jobs SET status='running', lease_until=?, worker_id=?, attempts=attempts+1, updated_at=? WHERE id=?`).run(leaseUntil, workerId, now, row.id);
      return { ...row, payload: JSON.parse(row.payload_json), attempts: row.attempts + 1, leaseUntil, status: "running" };
    });
    return tx();
  }

  completeJob(jobId, now = new Date().toISOString()) {
    this.db.prepare(`UPDATE jobs SET status='completed', completed_at=?, lease_until=NULL, updated_at=? WHERE id=?`).run(now, now, jobId);
  }

  failJob(jobId, error, { retry = false, availableAt = new Date().toISOString() } = {}) {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE jobs SET status=?, last_error=?, lease_until=NULL, available_at=?, updated_at=? WHERE id=?`).run(retry ? "queued" : "failed", String(error), availableAt, now, jobId);
  }

  saveSnapshot(snapshot) {
    this.db.prepare(`INSERT OR REPLACE INTO snapshots(id, collected_at, state_hash, json) VALUES(?, ?, ?, ?)`).run(snapshot.snapshotId, snapshot.collectedAt, snapshot.hashes.combined, JSON.stringify(snapshot));
  }

  latestSnapshot() {
    const row = this.db.prepare(`SELECT json FROM snapshots ORDER BY collected_at DESC LIMIT 1`).get();
    return row ? JSON.parse(row.json) : null;
  }

  latestReport(identity) {
    const row = this.db.prepare(`SELECT report_json FROM reports WHERE league_id=? AND team_id=? AND season=? AND (scoring_period_id IS ? OR scoring_period_id=?) ORDER BY sequence DESC LIMIT 1`).get(identity.leagueId, identity.teamId, identity.season, identity.scoringPeriodId ?? null, identity.scoringPeriodId ?? null);
    return row ? JSON.parse(row.report_json) : null;
  }

  nextSequence(identity) {
    const row = this.db.prepare(`SELECT COALESCE(MAX(sequence), 0) AS sequence FROM reports WHERE league_id=? AND team_id=? AND season=? AND (scoring_period_id IS ? OR scoring_period_id=?)`).get(identity.leagueId, identity.teamId, identity.season, identity.scoringPeriodId ?? null, identity.scoringPeriodId ?? null);
    return Number(row.sequence) + 1;
  }

  insertReport(report) {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO reports(report_id, league_id, team_id, season, scoring_period_id, sequence, state_hash, report_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(report.report_id, report.league_id, report.team_id, report.season, report.scoring_period_id, report.sequence, report.relevant_state_hash, JSON.stringify(report), now);
  }

  delivery(reportId) { return this.db.prepare(`SELECT * FROM deliveries WHERE report_id=?`).get(reportId) || null; }

  setDelivery(reportId, values) {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO deliveries(report_id, status, transport, provider_reference, error, updated_at, sent_at) VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(report_id) DO UPDATE SET status=excluded.status, transport=excluded.transport, provider_reference=excluded.provider_reference, error=excluded.error, updated_at=excluded.updated_at, sent_at=excluded.sent_at`).run(reportId, values.status, values.transport, values.providerReference || null, values.error || null, now, values.status === "sent" ? (values.sentAt || now) : null);
  }

  listJobs() { return this.db.prepare(`SELECT * FROM jobs ORDER BY id`).all().map((row) => ({ ...row, payload: JSON.parse(row.payload_json) })); }
  listReports() { return this.db.prepare(`SELECT report_json FROM reports ORDER BY sequence`).all().map((row) => JSON.parse(row.report_json)); }
}

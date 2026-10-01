import type { Db } from '../db/schema.js';

export type StepKind = 'question' | 'answer' | 'step' | 'outcome';
export type CaseStatus = 'open' | 'resolved' | 'escalated';

export interface CaseRecord {
  id: number;
  userId: string;
  productId: string | null;
  symptom: string | null;
  status: CaseStatus;
  createdAt: string;
}

export interface StepRecord {
  id: number;
  caseId: number;
  kind: StepKind;
  content: string;
  ts: string;
}

export interface SupportCaseRecord {
  id: number;
  caseId: number;
  summary: string;
  stepsTried: string[];
  warrantyStatus: string;
  ticketRef: string;
}

export interface CaseStore {
  open(input: { userId: string; productId?: string; symptom?: string }): CaseRecord;
  /** The case, but only if it belongs to the user. Someone else's case looks like one that does not exist. */
  get(caseId: number, userId: string): CaseRecord | undefined;
  latestOpen(userId: string): CaseRecord | undefined;
  update(caseId: number, patch: { productId?: string; symptom?: string; status?: CaseStatus }): void;
  addStep(caseId: number, kind: StepKind, content: string): StepRecord;
  steps(caseId: number): StepRecord[];
  supportCaseFor(caseId: number): SupportCaseRecord | undefined;
  /** Files the simulated ticket and marks the case escalated, together or not at all. */
  createSupportCase(input: { caseId: number; summary: string; stepsTried: string[]; warrantyStatus: string }): SupportCaseRecord;
}

interface CaseRow {
  id: number;
  user_id: string;
  product_id: string | null;
  symptom: string | null;
  status: CaseStatus;
  created_at: string;
}

interface StepRow {
  id: number;
  case_id: number;
  kind: StepKind;
  content: string;
  ts: string;
}

interface SupportRow {
  id: number;
  case_id: number;
  summary: string;
  steps_tried: string;
  warranty_status: string;
  ticket_ref: string;
}

const toCase = (row: CaseRow): CaseRecord => ({
  id: row.id,
  userId: row.user_id,
  productId: row.product_id,
  symptom: row.symptom,
  status: row.status,
  createdAt: row.created_at,
});

const toStep = (row: StepRow): StepRecord => ({
  id: row.id,
  caseId: row.case_id,
  kind: row.kind,
  content: row.content,
  ts: row.ts,
});

const toSupport = (row: SupportRow): SupportCaseRecord => ({
  id: row.id,
  caseId: row.case_id,
  summary: row.summary,
  stepsTried: JSON.parse(row.steps_tried) as string[],
  warrantyStatus: row.warranty_status,
  ticketRef: row.ticket_ref,
});

/** Case memory for troubleshooting conversations. Survives re-ingestion, unlike the catalog tables. */
export function createCaseStore(db: Db, now: () => Date = () => new Date()): CaseStore {
  const insertCase = db.prepare('INSERT INTO cases (user_id, product_id, symptom) VALUES (?, ?, ?)');
  const getCase = db.prepare('SELECT * FROM cases WHERE id = ? AND user_id = ?');
  const caseById = db.prepare('SELECT * FROM cases WHERE id = ?');
  const latestOpenCase = db.prepare(
    "SELECT * FROM cases WHERE user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1",
  );
  const insertStep = db.prepare('INSERT INTO diagnostic_steps (case_id, kind, content) VALUES (?, ?, ?)');
  const stepById = db.prepare('SELECT * FROM diagnostic_steps WHERE id = ?');
  const stepsOf = db.prepare('SELECT * FROM diagnostic_steps WHERE case_id = ? ORDER BY id');
  const supportOf = db.prepare('SELECT * FROM support_cases WHERE case_id = ?');
  const insertSupport = db.prepare(
    "INSERT INTO support_cases (case_id, summary, steps_tried, warranty_status, ticket_ref) VALUES (?, ?, ?, ?, '')",
  );
  const setTicket = db.prepare('UPDATE support_cases SET ticket_ref = ? WHERE id = ?');
  const setStatus = db.prepare('UPDATE cases SET status = ? WHERE id = ?');

  return {
    open({ userId, productId, symptom }) {
      const { lastInsertRowid } = insertCase.run(userId, productId ?? null, symptom ?? null);
      return toCase(caseById.get(lastInsertRowid) as CaseRow);
    },

    get(caseId, userId) {
      const row = getCase.get(caseId, userId) as CaseRow | undefined;
      return row ? toCase(row) : undefined;
    },

    latestOpen(userId) {
      const row = latestOpenCase.get(userId) as CaseRow | undefined;
      return row ? toCase(row) : undefined;
    },

    update(caseId, patch) {
      if (patch.productId !== undefined) db.prepare('UPDATE cases SET product_id = ? WHERE id = ?').run(patch.productId, caseId);
      if (patch.symptom !== undefined) db.prepare('UPDATE cases SET symptom = ? WHERE id = ?').run(patch.symptom, caseId);
      if (patch.status !== undefined) setStatus.run(patch.status, caseId);
    },

    addStep(caseId, kind, content) {
      const { lastInsertRowid } = insertStep.run(caseId, kind, content);
      return toStep(stepById.get(lastInsertRowid) as StepRow);
    },

    steps: (caseId) => (stepsOf.all(caseId) as StepRow[]).map(toStep),

    supportCaseFor(caseId) {
      const row = supportOf.get(caseId) as SupportRow | undefined;
      return row ? toSupport(row) : undefined;
    },

    createSupportCase({ caseId, summary, stepsTried, warrantyStatus }) {
      const file = db.transaction(() => {
        const { lastInsertRowid } = insertSupport.run(caseId, summary, JSON.stringify(stepsTried), warrantyStatus);
        const ticketRef = `RAI-${now().getUTCFullYear()}-${String(lastInsertRowid).padStart(6, '0')}`;
        setTicket.run(ticketRef, lastInsertRowid);
        setStatus.run('escalated', caseId);
        return toSupport(db.prepare('SELECT * FROM support_cases WHERE id = ?').get(lastInsertRowid) as SupportRow);
      });
      return file();
    },
  };
}

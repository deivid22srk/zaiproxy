import type { AppDatabase } from "./database.js";

export type StoredResponseRecord = {
  responseId: string;
  conversationKey: string;
  response: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type ResponseRow = {
  response_id: string;
  conversation_key: string;
  response_json: string;
  created_at: string;
  updated_at: string;
};

export class ResponseRepository {
  constructor(private readonly db: AppDatabase) {}

  get(responseId: string): StoredResponseRecord | null {
    const row = this.db
      .prepare("SELECT * FROM response_records WHERE response_id = ?")
      .get(responseId) as ResponseRow | undefined;
    return row ? fromRow(row) : null;
  }

  getConversationKey(responseId: string): string | null {
    const row = this.db
      .prepare("SELECT conversation_key FROM response_records WHERE response_id = ?")
      .get(responseId) as { conversation_key: string } | undefined;
    return row?.conversation_key ?? null;
  }

  save(responseId: string, conversationKey: string, response: Record<string, unknown>): void {
    const now = new Date().toISOString();
    const existing = this.get(responseId);
    this.db
      .prepare(
        `
        INSERT INTO response_records (
          response_id, conversation_key, response_json, created_at, updated_at
        ) VALUES (
          @responseId, @conversationKey, @responseJson, @createdAt, @updatedAt
        )
        ON CONFLICT(response_id) DO UPDATE SET
          conversation_key = excluded.conversation_key,
          response_json = excluded.response_json,
          updated_at = excluded.updated_at
      `
      )
      .run({
        responseId,
        conversationKey,
        responseJson: JSON.stringify(response),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      });
  }

  delete(responseId: string): void {
    this.db.prepare("DELETE FROM response_records WHERE response_id = ?").run(responseId);
  }

  prune(maxEntries: number): void {
    const rows = this.db
      .prepare(
        `
        SELECT response_id
        FROM response_records
        ORDER BY updated_at DESC
        LIMIT -1 OFFSET @maxEntries
      `
      )
      .all({ maxEntries }) as Array<{ response_id: string }>;
    if (rows.length === 0) return;

    const deleteOne = this.db.prepare("DELETE FROM response_records WHERE response_id = ?");
    const transaction = this.db.transaction((ids: string[]) => {
      for (const id of ids) deleteOne.run(id);
    });
    transaction(rows.map((row) => row.response_id));
  }
}

function fromRow(row: ResponseRow): StoredResponseRecord | null {
  try {
    return {
      responseId: row.response_id,
      conversationKey: row.conversation_key,
      response: JSON.parse(row.response_json) as Record<string, unknown>,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  } catch {
    return null;
  }
}

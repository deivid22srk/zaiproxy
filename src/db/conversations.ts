import type { AppDatabase } from "./database.js";

export type StoredConversation = {
  conversationKey: string;
  accountId: string;
  model: string;
  chatId: string;
  currentMessageId: string | null;
  updatedAt: number;
};

type ConversationRow = {
  conversation_key: string;
  account_id: string;
  model: string;
  chat_id: string;
  current_message_id: string | null;
  updated_at: string;
};

export class ConversationRepository {
  constructor(private readonly db: AppDatabase) {}

  get(conversationKey: string): StoredConversation | null {
    const row = this.db
      .prepare("SELECT * FROM conversations WHERE conversation_key = ?")
      .get(conversationKey) as ConversationRow | undefined;
    return row ? fromRow(row) : null;
  }

  save(input: Omit<StoredConversation, "updatedAt">): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO conversations (
          conversation_key, account_id, model, chat_id, current_message_id, updated_at
        ) VALUES (
          @conversationKey, @accountId, @model, @chatId, @currentMessageId, @updatedAt
        )
        ON CONFLICT(conversation_key) DO UPDATE SET
          account_id = excluded.account_id,
          model = excluded.model,
          chat_id = excluded.chat_id,
          current_message_id = excluded.current_message_id,
          updated_at = excluded.updated_at
      `
      )
      .run({ ...input, updatedAt: now });
  }

  delete(conversationKey: string): void {
    this.db.prepare("DELETE FROM conversations WHERE conversation_key = ?").run(conversationKey);
  }

  deleteBySuffix(suffix: string): number {
    const result = this.db
      .prepare("DELETE FROM conversations WHERE substr(conversation_key, -length(@suffix)) = @suffix")
      .run({ suffix });
    return Number(result.changes);
  }

  pruneOlderThan(timestampMs: number): number {
    const result = this.db
      .prepare("DELETE FROM conversations WHERE updated_at < @cutoff")
      .run({ cutoff: new Date(timestampMs).toISOString() });
    return Number(result.changes);
  }
}

function fromRow(row: ConversationRow): StoredConversation {
  return {
    conversationKey: row.conversation_key,
    accountId: row.account_id,
    model: row.model,
    chatId: row.chat_id,
    currentMessageId: row.current_message_id,
    updatedAt: Date.parse(row.updated_at) || 0
  };
}

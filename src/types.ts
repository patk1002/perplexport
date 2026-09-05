export interface Conversation {
  title: string;
  url: string;
  slug: string;
  updatedAt: string;
}

export interface DoneEntry {
  updatedAt: string;
  filename: string;
}

export interface DoneFile {
  processed: Record<string, DoneEntry>;
}
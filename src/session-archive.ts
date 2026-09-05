export interface SessionSummaryArchivePlan {
  sourcePath: string;
  destinationPath: string;
}

const DIRECT_SUMMARY = /^team\/([a-z][a-z0-9-]*)\/sessions\/([^/.][^/]*\.md)$/;

/** Pure, fail-closed plan for one explicitly selected vault session summary. */
export function planSessionSummaryArchive(options: { path: string; archiveAt: string }): SessionSummaryArchivePlan {
  const source = options.path.match(DIRECT_SUMMARY);
  if (source === null) throw new Error("Session archive source must be one direct vault session-summary Markdown file.");
  const date = options.archiveAt.match(/^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  if (date === null || Number.isNaN(Date.parse(options.archiveAt))) {
    throw new Error("Archive operation time must be a canonical ISO instant.");
  }
  return {
    sourcePath: options.path,
    destinationPath: `team/${source[1]}/sessions/archive/${date[1]}/${date[2]}/${date[3]}/${source[2]}`,
  };
}

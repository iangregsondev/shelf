// Warnings more than one command prints.

import type { TrashLeft } from "../domain/repo/repo-service";

/** The warning for a trash folder `shelf remove` or `shelf prune` could not delete. */
export const trashLeftWarning = (trash: TrashLeft): string =>
  `Warning: could not delete ${trash.path}: ${trash.message}. \`shelf remove\` or \`shelf prune\` will try again.`;

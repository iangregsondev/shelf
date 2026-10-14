import { describe, test, expect } from "vite-plus/test";
import { trashLeftWarning } from "../../src/cli/warnings";

describe("trashLeftWarning", () => {
  test("names the folder and the error, and says what retries it", () => {
    expect(
      trashLeftWarning({
        path: "/x/repos/.shelf-trash-lib-1",
        message: "EACCES: permission denied",
      }),
    ).toBe(
      "Warning: could not delete /x/repos/.shelf-trash-lib-1: EACCES: permission denied. `shelf remove` or `shelf prune` will try again.",
    );
  });
});

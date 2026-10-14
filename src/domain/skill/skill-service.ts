import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import type * as Option from "effect/Option";
import { FileSystem } from "effect/FileSystem";
import { join } from "node:path";
import { skillTemplate } from "./skill-template";
import { resolveSkillDir } from "./skill-utils";

export class SkillService extends Context.Service<SkillService>()(
  "shelf/domain/skill/SkillService",
  {
    make: Effect.gen(function* () {
      const fs = yield* FileSystem;

      return {
        /**
         * Writes the shelf skill file into `projectDir`, in the folder `agent`
         * reads skills from, replacing any older copy. Returns its path.
         */
        install: Effect.fn("SkillService.install")(function* (
          projectDir: string,
          agent: Option.Option<string>,
        ) {
          const skillDir = join(projectDir, resolveSkillDir(agent));
          const skillPath = join(skillDir, "SKILL.md");
          yield* fs.makeDirectory(skillDir, { recursive: true });
          yield* fs.writeFileString(skillPath, skillTemplate);
          return skillPath;
        }),
      };
    }),
  },
) {
  static layer = Layer.effect(this, this.make);
}

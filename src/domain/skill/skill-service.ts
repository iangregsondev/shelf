import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import { FileSystem } from "effect/FileSystem";
import { join } from "node:path";
import { ConfigService } from "../config/config-service";
import { osErrorMessage } from "../config/config-utils";
import { SkillWriteError, UnknownAgentError } from "./skill-errors";
import { skillReposPath, skillTemplate } from "./skill-template";
import { defaultSkillDir, knownAgents, resolveSkillDir } from "./skill-utils";

export class SkillService extends Context.Service<SkillService>()(
  "shelf/domain/skill/SkillService",
  {
    make: Effect.gen(function* () {
      const fs = yield* FileSystem;
      const config = yield* ConfigService;
      // The repos folder this shelf home uses, as the skill shows it to agents.
      const skillText = skillTemplate(skillReposPath(config.reposDir, config.userHome));

      return {
        /**
         * Writes the shelf skill file into `projectDir`, in the folder `agent`
         * reads skills from, replacing any older copy. Returns its path.
         * The skill names the shelf home's repos folder (`~/...` inside the user's home).
         * Fails with `UnknownAgentError`, writing nothing, for an agent shelf doesn't know.
         */
        install: Effect.fn("SkillService.install")(function* (
          projectDir: string,
          agent: Option.Option<string>,
        ) {
          let relativeDir = defaultSkillDir;
          if (Option.isSome(agent)) {
            const agentDir = resolveSkillDir(agent.value);
            if (agentDir === undefined) {
              return yield* new UnknownAgentError({ agent: agent.value, known: knownAgents });
            }
            relativeDir = agentDir;
          }
          const skillDir = join(projectDir, relativeDir);
          const skillPath = join(skillDir, "SKILL.md");
          yield* fs.makeDirectory(skillDir, { recursive: true }).pipe(
            Effect.andThen(fs.writeFileString(skillPath, skillText)),
            Effect.mapError(
              (error) => new SkillWriteError({ path: skillPath, message: osErrorMessage(error) }),
            ),
          );
          return skillPath;
        }),
      };
    }),
  },
) {
  static layer = Layer.effect(this, this.make);
}

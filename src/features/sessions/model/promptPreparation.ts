import { applyFileMentionsToTurn } from "../../files/model/fileMentions";
import { applyNotesToTurn } from "../../notes";
import {
  applySkillsToTurn,
  warmNativeSkills,
  isNativeCommandPrompt,
  type SkillCatalogContext,
} from "../../skills/model/skills";
import { nativeCommandPrompt } from "../../../integrations/harness/core/nativeCommands";
import {
  measureHarnessTiming,
  type HarnessTiming,
} from "../../../integrations/harness/core/timing";
import { prepareAttachments } from "./attachments";
import { beginSessionTurn } from "./checkpoint";
import type { Attachment } from "./session";
import { taskSessionPrompt } from "../../board/taskSession";

/** Independent reads overlap, but the pre-edit snapshot still gates dispatch. */
export async function prepareTurn(
  text: string,
  attachments: Attachment[],
  context: SkillCatalogContext & { sessionId: string },
  options: {
    checkpoint?: boolean;
    literal?: boolean;
    timing?: HarnessTiming;
  } = {},
): Promise<{ text: string; attachments: Attachment[] }> {
  const [prepared, prompt] = await Promise.all([
    measureHarnessTiming(options.timing, "attachments", () =>
      prepareAttachments(attachments, context.cwd),
    ),
    measureHarnessTiming(options.timing, "prompt", () =>
      options.literal ? Promise.resolve(text) : preparePrompt(text, context),
    ),
    options.checkpoint
      ? measureHarnessTiming(options.timing, "checkpoint", () =>
          beginSessionTurn(context.sessionId, context.cwd),
        )
          // Preserve the existing behavior when checkpoints are unavailable.
          .catch(() => undefined)
      : Promise.resolve(),
  ]);
  return {
    text: isNativeCommandPrompt(text, context.harness)
      ? prompt
      : taskSessionPrompt(prompt, context.sessionId, context.cwd),
    attachments: prepared,
  };
}

export async function preparePrompt(
  text: string,
  context: SkillCatalogContext,
): Promise<string> {
  warmNativeSkills(context);
  if (isNativeCommandPrompt(text, context.harness))
    return nativeCommandPrompt(context.harness, text);
  const withFiles = await applyFileMentionsToTurn(text, context.cwd);
  const withNotes = await applyNotesToTurn(withFiles);
  return applySkillsToTurn(withNotes, context);
}

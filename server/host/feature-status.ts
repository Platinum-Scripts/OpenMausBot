import {
  autoRecallEnabled,
  builtInBrowserEnabled,
  claudeUserMcpEnabled,
  llmThreadTitlesEnabled,
  roomMemoryCaptureEnabled,
  sharedComputersEnabled,
  showToolCallsEnabled,
  skillAuthoringEnabled,
  skillReviewSteps,
  type AppConfig,
} from "../config.ts";
import { singleChatFeedEnabled } from "../../shared/single-chat-feed.ts";
import { skillsLibraryEnabled } from "../skill-library.ts";
import { claudeUserSkillsEnabled } from "../turn-settings.ts";
import { parallelRoomJobsEnabled } from "./room-jobs.ts";

export interface FeatureStatusDeps {
  cfg: AppConfig;
  skillsHost: { mode(): "off" | "ask" | "auto" };
}

/** The `features` block of `GET /api/config`: every opt-in flag with its default applied. */
export function featureStatus({ cfg, skillsHost }: FeatureStatusDeps) {
  return {
    skillAuthoring: skillAuthoringEnabled(cfg),
    skillReview: cfg.features?.skillReview === true,
    skillReviewSteps: skillReviewSteps(cfg),
    skillsLibrary: skillsLibraryEnabled(cfg),
    shareLearnedSkills: skillsHost.mode(),
    showToolCalls: showToolCallsEnabled(cfg),
    browser: builtInBrowserEnabled(cfg),
    sharedComputers: sharedComputersEnabled(cfg),
    claudeUserMcp: claudeUserMcpEnabled(cfg),
    claudeUserSkills: claudeUserSkillsEnabled(cfg),
    autoRecall: autoRecallEnabled(cfg),
    roomMemoryCapture: roomMemoryCaptureEnabled(cfg),
    parallelRoomJobs: parallelRoomJobsEnabled(cfg),
    llmThreadTitles: llmThreadTitlesEnabled(cfg),
    singleChatFeed: singleChatFeedEnabled(cfg),
  };
}

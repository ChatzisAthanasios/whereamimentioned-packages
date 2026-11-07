/**
 * Registers every command group on the program (10-CLI section 2.4). Each module exports one
 * `register<Name>Commands(program, getContext)`; adding a group is one import and one call here,
 * and no module touches another's file.
 */
import type { Command } from "commander";
import type { Context } from "../context";
import { registerAuthCommands } from "./auth";
import { registerCompetitorCommands } from "./competitor";
import { registerCompletionCommands } from "./completion";
import { registerConfigCommands } from "./config-cmd";
import { registerMcpCommands } from "./mcp";
import { registerOrgCommands } from "./org";
import { registerPromptCommands } from "./prompt";
import { registerReportCommands } from "./report";
import { registerScanCommands } from "./scan";
import { registerSiteCommands } from "./site";
import { registerWorkspaceCommands } from "./workspace";

export function registerCommands(program: Command, getContext: () => Context): void {
  registerAuthCommands(program, getContext);
  registerConfigCommands(program, getContext);
  registerOrgCommands(program, getContext);
  registerWorkspaceCommands(program, getContext);
  registerScanCommands(program, getContext);
  registerReportCommands(program, getContext);
  registerCompetitorCommands(program, getContext);
  registerPromptCommands(program, getContext);
  registerSiteCommands(program, getContext);
  registerMcpCommands(program, getContext);
  registerCompletionCommands(program, getContext);
}

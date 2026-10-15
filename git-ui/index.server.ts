import type { PluginServerContext } from "@getpaseo/plugin/server";
import { disposeRepos } from "./server/git";
import { change, colors, commit, diff, files, lastCommitMessage, lines, status } from "./server/handlers";
import { clearHighlightCache } from "./server/highlight";
import { forgetStatusCaches } from "./server/status";
import {
  commitRpc,
  diffRpc,
  displaySettings,
  filesRpc,
  changeRpc,
  lastCommitMessageRpc,
  linesRpc,
  statusRpc,
  syntaxColorsRpc,
} from "./shared/git";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(displaySettings);
  server.handle(statusRpc, status);
  server.handle(diffRpc, diff);
  server.handle(linesRpc, lines);
  server.handle(changeRpc, change);
  server.handle(filesRpc, files);
  server.handle(commitRpc, commit);
  server.handle(lastCommitMessageRpc, lastCommitMessage);
  server.handle(syntaxColorsRpc, colors);
  return () => {
    disposeRepos();
    forgetStatusCaches();
    clearHighlightCache();
  };
}

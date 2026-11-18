import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createRefMessage } from "./client/ref-message";
import { WorkRefsSettings } from "./client/settings-screen";
import { MESSAGE_KIND, MESSAGE_VERSION, messageDataSchema } from "./shared/contracts";
import { hasRefs } from "./shared/refs";

export default function contribute(client: PluginClientContext) {
  const removals = [
    client.addTimelineTransformer({
      id: "work-refs",
      query: { itemType: "assistant_message" },
      transform({ item, phase }) {
        // Leave streaming text to Paseo: a half-written "#12" would resolve to the wrong item.
        if (phase !== "complete" || !hasRefs(item.text)) return undefined;
        return { items: [{ type: "plugin", kind: MESSAGE_KIND, version: MESSAGE_VERSION, data: { text: item.text } }] };
      },
    }),
    client.addTimelineRenderer({
      kind: MESSAGE_KIND,
      version: MESSAGE_VERSION,
      schema: messageDataSchema,
      Component: createRefMessage(client),
    }),
    client.addSettingsScreen({ id: "projects", title: "Work Item Links", icon: "Link", Component: WorkRefsSettings }),
  ];
  return () => {
    for (const remove of removals) void remove();
  };
}

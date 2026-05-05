import { ComposioSection } from "./ComposioSection.js";
import { PluggySection } from "./PluggySection.js";

export function ConnectionsPanel({ isDark }: { isDark: boolean }) {
  return (
    <div className="h-full overflow-y-auto debug-scroll">
      <PluggySection isDark={isDark} />
      <ComposioSection isDark={isDark} />
    </div>
  );
}

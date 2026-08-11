import { Check, ChevronDown, ChevronRight, CircleAlert, LoaderCircle, Terminal } from "lucide-react";
import { useState } from "react";
import type { UiToolCall } from "../conversation";

function renderValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function ToolCard({ tool }: { tool: UiToolCall }): React.JSX.Element {
  const [expanded, setExpanded] = useState(tool.status === "error");
  const Icon = tool.status === "running" ? LoaderCircle : tool.status === "error" ? CircleAlert : Check;
  return (
    <section className={`tool-card tool-card--${tool.status}`}>
      <button className="tool-card__header" onClick={() => setExpanded(value => !value)}>
        <span className="tool-card__glyph"><Terminal size={15} /></span>
        <span>
          <strong>{tool.name}</strong>
          <small>{tool.intent || (tool.status === "running" ? "正在执行" : tool.status === "error" ? "执行失败" : "执行完成")}</small>
        </span>
        <Icon className={tool.status === "running" ? "spin" : ""} size={15} />
        {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
      </button>
      {expanded && (
        <div className="tool-card__details">
          <label>输入</label>
          <pre>{renderValue(tool.args).slice(0, 30_000)}</pre>
          {tool.result !== undefined && (
            <>
              <label>结果</label>
              <pre>{renderValue(tool.result).slice(0, 50_000)}</pre>
            </>
          )}
        </div>
      )}
    </section>
  );
}

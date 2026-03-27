import { createContext, memo, useContext, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Check, Copy, ExternalLink, Eye, EyeOff, Layers, PanelRightOpen, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/use-theme";

const ArtifactCtx = createContext<{
  onOpenArtifact?: (code: string, lang: string) => void;
}>({});

const LANG_DISPLAY: Record<string, string> = {
  js: "JavaScript", jsx: "JavaScript", ts: "TypeScript", tsx: "TypeScript",
  py: "Python", python: "Python", rs: "Rust", go: "Go", java: "Java",
  cs: "C#", cpp: "C++", c: "C", html: "HTML", css: "CSS", scss: "SCSS",
  json: "JSON", yaml: "YAML", yml: "YAML", md: "Markdown", sh: "Shell",
  bash: "Bash", sql: "SQL", graphql: "GraphQL", php: "PHP", rb: "Ruby",
  swift: "Swift", kt: "Kotlin", dart: "Dart",
};

const PREVIEWABLE = ["html", "css", "js", "javascript"];
const JS_LANGS = ["js", "javascript"];
const CSS_LANGS = ["css", "scss"];

function extractCodeBlocks(content: string): { lang: string; code: string }[] {
  const regex = /```(\w+)\n([\s\S]*?)```/g;
  const blocks: { lang: string; code: string }[] = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    const lang = match[1].toLowerCase();
    if (PREVIEWABLE.includes(lang)) {
      blocks.push({ lang, code: match[2].replace(/\n$/, "") });
    }
  }
  return blocks;
}

function shouldShowCombined(blocks: { lang: string; code: string }[]): boolean {
  if (blocks.length < 2) return false;
  const langs = new Set(blocks.map((b) => b.lang));
  const hasHtml = langs.has("html");
  const hasCss = CSS_LANGS.some((l) => langs.has(l));
  const hasJs = JS_LANGS.some((l) => langs.has(l));
  return (hasHtml && hasCss) || (hasHtml && hasJs) || (hasCss && hasJs);
}

function buildCombinedSrcdoc(blocks: { lang: string; code: string }[]): string {
  const htmlBlock = blocks.find((b) => b.lang === "html");
  const cssCode = blocks
    .filter((b) => CSS_LANGS.includes(b.lang))
    .map((b) => b.code)
    .join("\n");
  const jsCode = blocks
    .filter((b) => JS_LANGS.includes(b.lang))
    .map((b) => b.code)
    .join("\n");

  if (htmlBlock) {
    let html = htmlBlock.code;

    if (cssCode) {
      const styleTag = `<style>\n${cssCode}\n</style>`;
      if (html.includes("</head>")) {
        html = html.replace("</head>", `${styleTag}\n</head>`);
      } else {
        html = styleTag + "\n" + html;
      }
    }

    if (jsCode) {
      const scriptTag = `<script>\n${jsCode}\n<\/script>`;
      if (html.includes("</body>")) {
        html = html.replace("</body>", `${scriptTag}\n</body>`);
      } else {
        html = html + "\n" + scriptTag;
      }
    }

    return html;
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { margin: 0; padding: 20px; font-family: system-ui, sans-serif; }
  ${cssCode}
</style>
</head>
<body>
<div id="output" style="font-family:system-ui,sans-serif;padding:8px"></div>
<script>
${jsCode}
<\/script>
</body>
</html>`;
}

function buildSrcdoc(lang: string, code: string): string {
  if (lang === "html") return code;

  if (lang === "css") {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { margin: 0; padding: 20px; font-family: system-ui, sans-serif; }
  ${code}
</style>
</head>
<body>
  <h1>Heading 1</h1>
  <h2>Heading 2</h2>
  <p>Ini adalah paragraf contoh untuk menampilkan style CSS kamu.</p>
  <button>Tombol</button>
  <ul><li>Item 1</li><li>Item 2</li><li>Item 3</li></ul>
</body>
</html>`;
  }

  if (lang === "js" || lang === "javascript") {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { margin: 0; font-family: system-ui, sans-serif; background: #0f0f11; color: #e4e4e7; }
  #output { padding: 16px; font-size: 13px; line-height: 1.7; }
  .log { padding: 4px 0; border-bottom: 1px solid #27272a; }
  .log-error { color: #f87171; }
  .log-warn { color: #fbbf24; }
  .label { color: #71717a; font-size: 11px; margin-bottom: 8px; font-family: monospace; }
</style>
</head>
<body>
<div id="output"><div class="label">// console output</div></div>
<script>
  const output = document.getElementById('output');
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  function appendLog(text, cls) {
    const div = document.createElement('div');
    div.className = 'log ' + (cls || '');
    div.textContent = text;
    output.appendChild(div);
  }

  console.log = (...args) => { appendLog(args.map(String).join(' ')); originalLog(...args); };
  console.warn = (...args) => { appendLog(args.map(String).join(' '), 'log-warn'); originalWarn(...args); };
  console.error = (...args) => { appendLog(args.map(String).join(' '), 'log-error'); originalError(...args); };

  try {
    ${code}
  } catch(e) {
    appendLog('Error: ' + e.message, 'log-error');
  }
<\/script>
</body>
</html>`;
  }

  return code;
}

function injectHideScrollbar(srcdoc: string): string {
  const style = `<style>::-webkit-scrollbar{display:none}*{scrollbar-width:none;-ms-overflow-style:none}</style>`;
  if (srcdoc.includes("</head>")) return srcdoc.replace("</head>", `${style}</head>`);
  return style + srcdoc;
}

function openInNewTab(srcdoc: string) {
  const blob = new Blob([srcdoc], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const tab = window.open(url, "_blank");
  if (tab) {
    tab.addEventListener("unload", () => URL.revokeObjectURL(url), { once: true });
  }
}

function LivePreview({ srcdoc }: { srcdoc: string }) {
  const [key, setKey] = useState(0);

  return (
    <div className="rounded-b-lg overflow-hidden border-t border-white/[0.06]">
      <div className="flex items-center justify-between bg-[#111113] px-4 py-2">
        <div className="flex items-center gap-2">
          <div className="flex gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
            <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
            <div className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
          </div>
          <span className="text-[11px] text-zinc-500 font-mono ml-2">preview</span>
        </div>
        <button
          onClick={() => setKey((k) => k + 1)}
          className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
          title="Reload preview"
        >
          <RefreshCw className="w-3 h-3" />
          Reload
        </button>
      </div>
      <iframe
        key={key}
        srcDoc={injectHideScrollbar(srcdoc)}
        sandbox="allow-scripts allow-same-origin"
        className="w-full bg-white"
        style={{ height: "320px", border: "none" }}
        title="Code preview"
      />
    </div>
  );
}

function CombinedPreview({ blocks }: { blocks: { lang: string; code: string }[] }) {
  const { onOpenArtifact } = useContext(ArtifactCtx);
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const [show, setShow] = useState(false);
  const [key, setKey] = useState(0);
  const srcdoc = useMemo(() => buildCombinedSrcdoc(blocks), [blocks]);

  const langLabels = [...new Set(blocks.map((b) => LANG_DISPLAY[b.lang] ?? b.lang.toUpperCase()))].join(" + ");

  return (
    <div className={cn("my-4 rounded-lg overflow-hidden border border-primary/30", isDark ? "bg-[#18181b]" : "bg-zinc-100")}>
      <div className={cn("flex items-center justify-between px-4 py-3.5 border-b", isDark ? "border-white/[0.06]" : "border-black/[0.06]")}>
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-primary" />
          <span className={cn("text-sm font-medium", isDark ? "text-zinc-400" : "text-zinc-600")}>
            Preview Gabungan <span className={isDark ? "text-zinc-600" : "text-zinc-400"}>({langLabels})</span>
          </span>
        </div>
        <div className="flex items-center gap-3">
          {show && (
            <button
              onClick={() => setKey((k) => k + 1)}
              className={cn("flex items-center gap-1 text-[11px] transition-colors", isDark ? "text-zinc-500 hover:text-zinc-300" : "text-zinc-500 hover:text-zinc-700")}
            >
              <RefreshCw className="w-3 h-3" />
              Reload
            </button>
          )}
          <button
            onClick={() => setShow((v) => !v)}
            className={cn("flex items-center gap-1.5 text-xs font-medium transition-all duration-150", isDark ? "text-zinc-500 hover:text-zinc-300" : "text-zinc-500 hover:text-zinc-700")}
            title={show ? "Sembunyikan preview" : "Tampilkan preview inline"}
          >
            {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={() => openInNewTab(srcdoc)}
            className={cn("flex items-center gap-1.5 text-xs font-medium transition-all duration-150", isDark ? "text-zinc-500 hover:text-zinc-300" : "text-zinc-500 hover:text-zinc-700")}
            title="Buka di tab baru"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
          {onOpenArtifact && (
            <button
              onClick={() => onOpenArtifact(srcdoc, "html")}
              className={cn("flex items-center gap-1.5 text-xs font-medium hover:text-primary transition-all duration-150", isDark ? "text-zinc-400" : "text-zinc-500")}
              title="Buka di Artifact Panel"
            >
              <PanelRightOpen className="w-3.5 h-3.5" />
              Buka Panel
            </button>
          )}
        </div>
      </div>

      {show && (
        <iframe
          key={key}
          srcDoc={injectHideScrollbar(srcdoc)}
          sandbox="allow-scripts allow-same-origin"
          className="w-full bg-white"
          style={{ height: "380px", border: "none" }}
          title="Combined code preview"
        />
      )}
    </div>
  );
}

const CodeBlock = ({ inline, className, children, ...props }: any) => {
  const { onOpenArtifact } = useContext(ArtifactCtx);
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const match = /language-(\w+)/.exec(className || "");
  const lang = match?.[1]?.toLowerCase() ?? "";
  const displayLang = LANG_DISPLAY[lang] ?? (lang ? lang.toUpperCase() : null);
  const [copied, setCopied] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  const codeStr = String(children).replace(/\n$/, "");
  const canPreview = PREVIEWABLE.includes(lang);

  const handleCopy = () => {
    navigator.clipboard.writeText(codeStr);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!inline && match) {
    return (
      <div className={cn("group relative my-4 rounded-lg overflow-hidden", isDark ? "bg-[#18181b]" : "bg-zinc-100")}>
        <div className={cn("flex items-center justify-between px-4 py-2 border-b", isDark ? "border-white/[0.06]" : "border-black/[0.06]")}>
          <span className={cn("text-xs font-medium", isDark ? "text-zinc-500" : "text-zinc-500")}>
            {displayLang}
          </span>
          <div className="flex items-center gap-3">
            {canPreview && (
              <button
                onClick={() => openInNewTab(buildSrcdoc(lang, codeStr))}
                className={cn("flex items-center gap-1.5 text-xs font-medium transition-all duration-150", isDark ? "text-zinc-500 hover:text-zinc-300" : "text-zinc-500 hover:text-zinc-700")}
                title="Buka di tab baru"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              onClick={handleCopy}
              className={cn(
                "flex items-center gap-1.5 text-xs font-medium transition-all duration-150",
                copied
                  ? isDark ? "text-green-400" : "text-green-600"
                  : isDark ? "text-zinc-500 hover:text-zinc-300" : "text-zinc-500 hover:text-zinc-700"
              )}
            >
              {copied ? (
                <><Check className="w-3.5 h-3.5" /> Copied</>
              ) : (
                <><Copy className="w-3.5 h-3.5" /> Copy</>
              )}
            </button>
            {onOpenArtifact && (
              <button
                onClick={() => onOpenArtifact(codeStr, lang)}
                className={cn("flex items-center gap-1.5 text-xs font-medium hover:text-primary transition-all duration-150", isDark ? "text-zinc-400" : "text-zinc-500")}
                title="Buka di Artifact Panel"
              >
                <PanelRightOpen className="w-3.5 h-3.5" />
                Panel
              </button>
            )}
          </div>
        </div>

        <div style={{ maxHeight: "500px", overflow: "auto" }}>
          <SyntaxHighlighter
            style={isDark ? oneDark : oneLight}
            language={lang}
            PreTag="div"
            showLineNumbers={false}
            customStyle={{
              margin: 0,
              padding: "1rem 1.25rem",
              background: "transparent",
              fontSize: "0.85rem",
              lineHeight: "1.7",
            }}
            codeTagProps={{ className: "font-mono" }}
            {...props}
          >
            {codeStr}
          </SyntaxHighlighter>
        </div>

        {showPreview && canPreview && (
          <LivePreview srcdoc={buildSrcdoc(lang, codeStr)} />
        )}
      </div>
    );
  }

  return (
    <code
      className={cn(
        "bg-zinc-100 dark:bg-zinc-800 text-rose-600 dark:text-rose-400 px-1.5 py-0.5 rounded text-[0.85em] font-mono",
        className
      )}
      {...props}
    >
      {children}
    </code>
  );
};

export const MarkdownRenderer = memo(({ content, onOpenArtifact, isStreaming }: {
  content: string;
  onOpenArtifact?: (code: string, lang: string) => void;
  isStreaming?: boolean;
}) => {
  const combinedBlocks = useMemo(() => isStreaming ? [] : extractCodeBlocks(content), [isStreaming, content]);
  const showCombined = !isStreaming && shouldShowCombined(combinedBlocks);

  return (
    <ArtifactCtx.Provider value={{ onOpenArtifact }}>
      <div className="prose prose-slate max-w-none dark:prose-invert text-[15px] leading-relaxed
        prose-p:my-2 prose-p:leading-relaxed
        prose-headings:font-semibold prose-headings:text-foreground
        prose-h1:text-xl prose-h2:text-lg prose-h3:text-base
        prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5
        prose-strong:text-foreground prose-strong:font-semibold
        prose-blockquote:border-l-primary prose-blockquote:text-muted-foreground
        prose-pre:p-0 prose-pre:bg-transparent prose-pre:border-0 prose-pre:shadow-none
      ">
        <ReactMarkdown
          components={{
            code: CodeBlock,
            img: ({ src, alt }) => (
              <span className="block my-3">
                <img
                  src={src}
                  alt={alt || "Generated image"}
                  className="rounded-xl border border-border shadow-md max-w-[360px] w-full"
                  loading="lazy"
                />
              </span>
            ),
          }}
        >
          {content}
        </ReactMarkdown>

        {showCombined && <CombinedPreview blocks={combinedBlocks} />}
      </div>
    </ArtifactCtx.Provider>
  );
});

MarkdownRenderer.displayName = "MarkdownRenderer";

export { buildSrcdoc, buildCombinedSrcdoc, injectHideScrollbar, PREVIEWABLE, LANG_DISPLAY };

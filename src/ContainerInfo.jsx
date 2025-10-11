import React from "react";
import cockpit from "cockpit";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const DEFAULT_README_PATH = "/usr/share/versanode/README.md";

export default function ContainerInfo({ container, health }) {
  const [md, setMd] = React.useState("");
  const [err, setErr] = React.useState("");
  const [loading, setLoading] = React.useState(true);

  const readmePath =
    container?.Config?.Labels?.["io.versanode.vncp.readme.path"] ||
    "/usr/share/versanode/README.md";

  React.useEffect(() => {
    let cancelled = false;

    async function fetchReadme() {
      setLoading(true);
      setErr("");
      try {
        const out = await cockpit
          .spawn(["docker", "exec", container.Id, "cat", readmePath], {
            superuser: "try",
            err: "message",
          });
        if (!cancelled) setMd(out);
      } catch (e) {
        if (!cancelled) {
          setMd("");
          setErr(e?.message || String(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchReadme();
    return () => { cancelled = true; };
 }, [container?.Id, readmePath, health]); 

  if (loading) return <div className="pf-v5-c-skeleton" style={{ height: 16 }} />;
  if (err && !md) return <div className="pf-v5-c-helper-text pf-m-error">{err}</div>;
  if (!md) return <div className="pf-v5-c-helper-text">{_("No README found.")}</div>;

  // Render markdown
  return (
    <div className="vncp-readme pf-v5-c-content">
      <ReactMarkdown remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer" />
          ),
        }}
      >
        {md}
      </ReactMarkdown>
    </div>
  );
}

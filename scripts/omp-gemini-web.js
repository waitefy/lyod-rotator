/** OMP extension: keep unsupported tools out of Gemini Web requests. */
export default function geminiWebTools(api) {
  const supported = new Set(["read", "glob", "grep", "edit", "write", "bash"]);
  let savedTools;
  let savedThinking;

  const configure = async (_event, ctx) => {
    const isWeb = ctx.model?.provider === "tuxevil-rotator" &&
      /^gemini-4-argon-web(?:-(?:low|medium|high))?$/.test(ctx.model.id);
    if (isWeb) {
      if (savedTools === undefined) {
        savedTools = api.getActiveTools();
        savedThinking = api.getThinkingLevel();
      }
      const active = api.getActiveTools();
      const allowed = active.filter((name) => supported.has(name));
      if (allowed.length !== active.length) await api.setActiveTools(allowed);
      api.setThinkingLevel("off");
    } else if (savedTools !== undefined) {
      await api.setActiveTools(savedTools);
      if (savedThinking !== undefined) api.setThinkingLevel(savedThinking);
      savedTools = undefined;
      savedThinking = undefined;
    }
  };

  api.on("session_start", configure);
  api.on("before_agent_start", configure);
  api.on("turn_start", configure);
}

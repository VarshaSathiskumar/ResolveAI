import { useEffect, useRef, useState } from 'react';
import { readResource } from '../api';
import { createBridge, initializeApp, loadSandboxProxy } from '../apps/bridge';
import type { UiResource } from '../state';

/**
 * Shows the result of a tool as its MCP App view (the support ticket card): the view's HTML is read through the
 * backend and runs in a sandboxed iframe on a different origin, talking to this page only through the bridge.
 */
export function AppView({ sessionId, resource, title }: { sessionId: string; resource: UiResource; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [failed, setFailed] = useState<string>();

  useEffect(() => {
    const iframe = frame.current!;
    let closed = false;
    let bridge: ReturnType<typeof createBridge> | undefined;

    (async () => {
      const content = await readResource(sessionId, resource.uri);
      const meta = (content.meta as { ui?: { csp?: Record<string, string[]>; permissions?: Record<string, unknown> } } | undefined)?.ui;
      const loaded = await loadSandboxProxy(iframe, meta?.csp, meta?.permissions);
      if (!loaded || closed) return;
      bridge = createBridge(iframe, { onError: (message) => !closed && setFailed(message) });
      await initializeApp(iframe, bridge, {
        html: content.text,
        csp: meta?.csp,
        permissions: meta?.permissions,
        input: resource.input,
        result: { content: [{ type: 'text', text: resource.result.text }], ...(resource.result.structuredContent ? { structuredContent: resource.result.structuredContent } : {}) },
      });
    })().catch((error: unknown) => !closed && setFailed(error instanceof Error ? error.message : 'The card could not be shown.'));

    return () => {
      closed = true;
      void bridge?.close?.();
    };
  }, [sessionId, resource]);

  return (
    <div className="app-view">
      <iframe ref={frame} title={title} className="app-frame" />
      {failed && <p className="muted app-view__error">The card could not be shown ({failed}). The ticket is in the text above.</p>}
    </div>
  );
}

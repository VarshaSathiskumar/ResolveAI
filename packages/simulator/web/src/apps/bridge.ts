import { AppBridge, PostMessageTransport, buildAllowAttribute } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { McpUiResourceCsp, McpUiResourcePermissions, McpUiSandboxProxyReadyNotification } from '@modelcontextprotocol/ext-apps/app-bridge';
import { HOST_STYLE_VARIABLES } from './hostStyles';
import { APP_HOST_INFO, sandboxPort } from '../../../../../config.js';

/** The sandbox page must be on another origin than this app, so a view can never reach the host's page or storage. */
const SANDBOX_PORT = sandboxPort(import.meta.env);

export interface CallToolResultLike {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
}

export interface BridgeHooks {
  onError?: (message: string) => void;
}

function sandboxUrl(csp?: McpUiResourceCsp): string {
  const url = new URL(`${location.protocol}//${location.hostname}:${SANDBOX_PORT}/sandbox.html`);
  if (csp) url.searchParams.set('csp', JSON.stringify(csp));
  return url.href;
}

/** Loads the sandbox proxy page into the iframe and resolves when it says it is ready for the view. */
export function loadSandboxProxy(iframe: HTMLIFrameElement, csp?: McpUiResourceCsp, permissions?: McpUiResourcePermissions): Promise<boolean> {
  if (iframe.src) return Promise.resolve(false);
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
  const allow = buildAllowAttribute(permissions);
  if (allow) iframe.setAttribute('allow', allow);

  const ready: McpUiSandboxProxyReadyNotification['method'] = 'ui/notifications/sandbox-proxy-ready';
  const loaded = new Promise<boolean>((resolve) => {
    const listener = ({ source, data }: MessageEvent) => {
      if (source === iframe.contentWindow && data?.method === ready) {
        window.removeEventListener('message', listener);
        resolve(true);
      }
    };
    window.addEventListener('message', listener);
  });
  iframe.src = sandboxUrl(csp);
  return loaded;
}

/**
 * The host side of an MCP App. There is no MCP client in the browser, so the bridge gets none: the view can show
 * the result it is given, but it cannot call tools or read resources on the server by itself.
 */
export function createBridge(iframe: HTMLIFrameElement, hooks: BridgeHooks = {}): AppBridge {
  const bridge = new AppBridge(null, APP_HOST_INFO, { openLinks: {} }, {
    hostContext: {
      theme: 'dark',
      platform: 'web',
      styles: { variables: HOST_STYLE_VARIABLES },
      containerDimensions: { maxHeight: 600 },
      displayMode: 'inline',
      availableDisplayModes: ['inline'],
    },
  });

  // Every handler is registered before connect(): the view can send requests as soon as the handshake is done.
  bridge.onmessage = async () => ({});
  bridge.onupdatemodelcontext = async () => ({});
  bridge.onloggingmessage = (params) => console.debug('[card]', params);
  bridge.onrequestdisplaymode = async () => ({ mode: 'inline' });
  bridge.onopenlink = async ({ url }) => {
    // Only web links: a view must not be able to open anything else from here.
    if (!/^https?:\/\//i.test(url)) return { isError: true };
    window.open(url, '_blank', 'noopener,noreferrer');
    return {};
  };
  bridge.onsizechange = async ({ height }) => {
    if (height !== undefined) iframe.style.height = `${Math.ceil(height)}px`;
  };
  bridge.onerror = (error) => hooks.onError?.(error.message);
  return bridge;
}

/** Connects the bridge, hands the view its HTML, then the tool input and result, once the view says it is ready. */
export async function initializeApp(
  iframe: HTMLIFrameElement,
  bridge: AppBridge,
  app: { html: string; csp?: McpUiResourceCsp; permissions?: McpUiResourcePermissions; input: unknown; result: CallToolResultLike },
): Promise<void> {
  const initialized = new Promise<void>((resolve) => {
    const previous = bridge.oninitialized;
    bridge.oninitialized = (...args) => {
      resolve();
      bridge.oninitialized = previous;
      bridge.oninitialized?.(...args);
    };
  });
  // The window is passed as both target and source so this bridge only talks to this one iframe.
  await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
  await bridge.sendSandboxResourceReady({ html: app.html, csp: app.csp, permissions: app.permissions });
  await initialized;
  bridge.sendToolInput({ arguments: (app.input ?? {}) as Record<string, unknown> });
  bridge.sendToolResult(app.result);
}

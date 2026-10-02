import type { McpUiStyles } from '@modelcontextprotocol/ext-apps';

/** The simulator's dark theme, handed to MCP App views as CSS variables so a card matches the page around it. */
export const HOST_STYLE_VARIABLES: McpUiStyles = {
  '--color-background-primary': '#111a2e',
  '--color-background-secondary': '#16213a',
  '--color-background-tertiary': '#1b2a4a',
  '--color-text-primary': '#e8eefc',
  '--color-text-secondary': '#8fa0c4',
  '--color-text-tertiary': '#6b7da3',
  '--color-border-primary': '#243252',
  '--color-border-secondary': '#33466f',
  '--color-text-success': '#34d399',
  '--color-text-warning': '#fbbf24',
  '--color-text-danger': '#f87171',
  '--font-sans': "system-ui, -apple-system, 'Segoe UI', sans-serif",
  '--font-mono': 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  '--border-radius-md': '14px',
} as McpUiStyles;

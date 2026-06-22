export function generateProviderConfig(proxyPort: number): Record<string, unknown> {
  return {
    'opencode-go-router': {
      type: 'native',
      url: `http://localhost:${proxyPort}`,
      settings: {
        apiKey: 'router-managed',
      },
    },
  }
}

export function printSetupInstructions(proxyPort: number, dashboardPort: number): void {
  console.log(`
╔══════════════════════════════════════════════════════╗
║         OpenCode Go Router — Setup Guide            ║
╠══════════════════════════════════════════════════════╣
║                                                      ║
║  1. OpenCode is configured to use this router as     ║
║     your Go API provider.                            ║
║                                                      ║
║  2. Configure OpenCode to point to the proxy:        ║
║                                                      ║
║     In ~/.opencode/config.json or opencode.json:     ║
║     {                                                ║
║       "provider": {                                  ║
║         "opencode-go-router": {                      ║
║           "type": "native",                          ║
║           "url": "http://localhost:${proxyPort}",         ║
║           "settings": {}                             ║
║         }                                            ║
║       }                                              ║
║     }                                                ║
║                                                      ║
║  3. Dashboard is available at:                       ║
║     http://localhost:${dashboardPort}                    ║
║                                                      ║
║  4. Add your Go API keys via the Dashboard.          ║
║                                                      ║
╚══════════════════════════════════════════════════════╝
`)
}

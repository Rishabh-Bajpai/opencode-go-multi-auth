export function generateProviderConfig(proxyPort: number): Record<string, unknown> {
  return {
    'opencode-go': {
      options: {
        baseURL: `http://localhost:${proxyPort}`,
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
║  1. Add this to ~/.opencode/opencode.json:          ║
║                                                      ║
║     {                                                ║
║       "provider": {                                  ║
║         "opencode-go": {                             ║
║           "options": {                               ║
║             "baseURL": "http://localhost:${proxyPort}"  ║
║           }                                          ║
║         }                                            ║
║       }                                              ║
║     }                                                ║
║                                                      ║
║  2. Dashboard is available at:                       ║
║     http://localhost:${dashboardPort}                    ║
║                                                      ║
║  3. Add your Go API keys via the Dashboard.          ║
║                                                      ║
╚══════════════════════════════════════════════════════╝
`)
}

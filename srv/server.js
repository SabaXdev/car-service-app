const cds = require('@sap/cds')

cds.on('bootstrap', (app) => {
  app.post('/sap/bc/ui2/flp;sap-metrics-only', (_req, res) => res.sendStatus(204))
})

module.exports = cds.server

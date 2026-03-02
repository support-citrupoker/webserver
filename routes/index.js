import { join } from 'path'


export default (app) => {

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
  })

  app.get('*', (req, res) => { return res.sendFile(join(`${__basedir}/dist/index.html`)) })


}

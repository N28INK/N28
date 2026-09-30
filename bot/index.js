const config = require('./src/config');
const app = require('./src/server');

app.listen(config.port, () => console.log(`🚀 Bot de Marketplace corriendo en el puerto ${config.port}`));

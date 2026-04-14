// TeachingBoard backend entrypoint.
require("dotenv").config();

const app = require("./src/app");
const { testConnection } = require("./src/config/db");

const PORT = Number(process.env.PORT || 4000);

async function bootstrap() {
  await testConnection();

  app.listen(PORT, () => {
    console.log(`TeachingBoard backend running on http://localhost:${PORT}`);
  });
}

bootstrap().catch((error) => {
  console.error("Failed to start TeachingBoard backend:", error.message);
  process.exit(1);
});

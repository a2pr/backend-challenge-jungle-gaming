import { defineConfig } from '@mikro-orm/postgresql';

export default defineConfig({
  clientUrl: process.env.DATABASE_URL,
  entities: ['./dist/**/*.schema.js'],
  entitiesTs: ['./src/**/*.schema.ts'],
  discovery: { warnWhenNoEntities: false }, // remove once the first *.schema.ts exists
});

import {defineConfig} from '@mikro-orm/postgresql';
import {Migrator} from "@mikro-orm/migrations";

export default defineConfig({
    clientUrl: process.env.DATABASE_URL,
    entities: ['./dist/**/*.schema.js'],
    entitiesTs: ['./src/**/*.schema.ts'],
    extensions: [Migrator],
    migrations: {path: './dist/migrations', pathTs: './src/migrations', transactional: true, snapshot: false},
    pool: {min: 2, max: Number(process.env.DATABASE_POOL_MAX ?? 20)}

});

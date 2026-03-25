import { syncModule } from "./redis";

async function main(): Promise<void> {
  return await syncModule.removeContainer();
}

main();

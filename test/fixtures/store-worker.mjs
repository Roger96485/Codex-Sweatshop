import { Store } from '../../src/store.mjs';
try {
  const store=new Store(process.argv[2]);console.log('acquired');
  await new Promise(resolve=>setTimeout(resolve,350));store.close();
} catch(error){console.log('blocked');process.exitCode=1;}

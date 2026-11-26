import {test} from "node:test";
import assert from "node:assert/strict";
import {configDirectory,dataDirectory,StateStore} from "../../src/standalone/state";

test("preview profile uses separate state and data paths",async()=>{
  const old=process.env.ACCODING_PROFILE;
  try {
    delete process.env.ACCODING_PROFILE;
    const stable=[configDirectory(),dataDirectory(),new StateStore().file];
    process.env.ACCODING_PROFILE="preview";
    const preview=[configDirectory(),dataDirectory(),new StateStore().file];
    for(let i=0;i<stable.length;i++) assert.notEqual(stable[i],preview[i]);
    delete process.env.ACCODING_PROFILE;
    assert.deepEqual([configDirectory(),dataDirectory(),new StateStore().file],stable);
  } finally {
    if(old===undefined) delete process.env.ACCODING_PROFILE;
    else process.env.ACCODING_PROFILE=old;
  }
});

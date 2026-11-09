import test from 'node:test';
import assert from 'node:assert/strict';
import {checkedPrices,currentPrices} from './prices.mjs';
import {createPendingOrder,makeProviderChecks,validateProviderSlip} from '../payments-v2/core.mjs';
const uid='user-from-firebase';
const uuid='00000000-0000-4000-8000-000000000011';
test('admin prices require exactly three server-trusted integer values',()=>{
 assert.deepEqual(checkedPrices({vip:120,shield:15,win2:25}),{vip:120,shield:15,win2:25});
 assert.throws(()=>checkedPrices({vip:100,shield:0,win2:20}));
 assert.throws(()=>checkedPrices({vip:100,shield:1.5,win2:20}));
 assert.throws(()=>checkedPrices({vip:100,shield:1,win2:20,unknown:3}));
 assert.deepEqual(currentPrices(null),{vip:100,shield:10,win2:20});
});
test('existing payable order retains original amount even if admin changes future prices',()=>{
 const old=createPendingOrder({uid,sku:'vip',uuid,now:1_000_000,amountBaht:100});
 const fresh=createPendingOrder({uid,sku:'vip',uuid:'00000000-0000-4000-8000-000000000012',now:1_100_000,amountBaht:120});
 assert.equal(old.amountBaht,100);assert.equal(fresh.amountBaht,120);
 const receiver={accountType:'02004',accountNumber:'000000000000000'};
 assert.equal(makeProviderChecks(old,receiver).checkAmount.amount,'100');
 assert.equal(makeProviderChecks(fresh,receiver).checkAmount.amount,'120');
 assert.throws(()=>createPendingOrder({uid,sku:'vip',uuid,amountBaht:5001}));
});

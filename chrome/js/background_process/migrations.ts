/* © 2016-2018 FlowCrypt Limited. Limitations apply. Contact human@flowcrypt.com */

'use strict';

/// <reference path="../../../node_modules/@types/chrome/index.d.ts" />
/// <reference path="../../../node_modules/@types/jquery/index.d.ts" />
/// <reference path="../../../node_modules/@types/openpgp/index.d.ts" />
/// <reference path="../common/common.d.ts" />

function migrate_account(data: {account_email: string}, sender: chrome.runtime.MessageSender|'background', respond_done: Callback) {
  (window as FlowCryptWindow).flowcrypt_storage.get(data.account_email, ['version'], function(account_storage) {
    (window as FlowCryptWindow).flowcrypt_storage.set(data.account_email, { version: catcher.version('int') }, respond_done);
    account_update_status_pks(data.account_email);
    account_update_status_keyserver(data.account_email);
  });
}

function migrate_global(callback: Callback) {
  migrate_local_storage_to_extension_storage(() => {
    callback();
  });
}

function migrate_local_storage_to_extension_storage(callback: Callback) {
  if(window.localStorage.length === 0) {
    callback(); // nothing in localStorage
  } else {
    let values: Dict<FlatTypes> = {};
    tool.each(localStorage, (legacy_storage_key: string, legacy_storage_value: string) => {
      let value = legacy_local_storage_read(legacy_storage_value);
      if(legacy_storage_key === 'settings_seen') {
        values['cryptup_global_settings_seen'] = true;
      } else if(legacy_storage_key.match(/^cryptup_[a-z0-9]+_keys$/g)) {
        values[legacy_storage_key] = value;
      } else if(legacy_storage_key.match(/^cryptup_[a-z0-9]+_master_passphrase$/g)) {
        try {
          let primary_longid = legacy_local_storage_read(localStorage[legacy_storage_key.replace('master_passphrase', 'keys')]).filter((ki: KeyInfo) => ki.primary)[0].longid;
          values[legacy_storage_key.replace('master_passphrase', 'passphrase_' + primary_longid)] = value;
        } catch (e) {}  // this would fail if user manually edited storage. Defensive coding in case that crashes migration. They'd need to enter their phrase again.
      } else if(legacy_storage_key.match(/^cryptup_[a-z0-9]+_passphrase_[0-9A-F]{16}$/g)) {
        values[legacy_storage_key] = value;
      }
    });
    chrome.storage.local.set(values, () => {
      localStorage.clear();
      callback();
    });
  }
}

function legacy_local_storage_read(value: string) {
  if(typeof value === 'undefined') {
    return value;
  } else if(value === 'null#null') {
    return null;
  } else if(value === 'bool#true') {
    return true;
  } else if(value === 'bool#false') {
    return false;
  } else if(value.indexOf('int#') === 0) {
    return Number(value.replace(/^int#/, ''));
  } else if(value.indexOf('json#') === 0) {
    return JSON.parse(value.replace(/^json#/, ''));
  } else {
    return value.replace(/^str#/, '');
  }
}

function account_update_status_keyserver(account_email: string) { // checks which emails were registered on Attester
  (window as FlowCryptWindow).flowcrypt_storage.keys_get(account_email).then((keyinfos: KeyInfo[]) => {
    let my_longids = keyinfos.map(ki => ki.longid);
    (window as FlowCryptWindow).flowcrypt_storage.get(account_email, ['addresses', 'addresses_keyserver'], function(storage: Dict<string[]>) {
      if(storage.addresses && storage.addresses.length) {
        tool.api.attester.lookup_email(storage.addresses).then((results: {results: PubkeySearchResult[]}) => {
          let addresses_keyserver = [];
          for(let result of results.results) {
            if(result && result.pubkey && tool.value(tool.crypto.key.longid(result.pubkey)).in(my_longids)) {
              addresses_keyserver.push(result.email);
            }
          }
          (window as FlowCryptWindow).flowcrypt_storage.set(account_email, { addresses_keyserver: addresses_keyserver, });
        }, function(error) {});
      }
    });
  });
}

function account_update_status_pks(account_email: string) { // checks if any new emails were registered on pks lately
  (window as FlowCryptWindow).flowcrypt_storage.keys_get(account_email).then((keyinfos: KeyInfo[]) => {
    let my_longids = keyinfos.map(ki => ki.longid);
    let hkp = new openpgp.HKP('https://pgp.key-server.io');
    (window as FlowCryptWindow).flowcrypt_storage.get(account_email, ['addresses', 'addresses_pks'], function(storage: Dict<string[]>) {
      let addresses_pks = storage.addresses_pks || [];
      for (let email of storage.addresses || [account_email]) {
        if(!tool.value(email).in(addresses_pks)) {
          try {
            // @ts-ignore
            hkp.lookup({ query: email }).then((pubkey: string) => {
              if(typeof pubkey !== 'undefined') {
                if(tool.value(tool.crypto.key.longid(pubkey)).in(my_longids)) {
                  addresses_pks.push(email);
                  console.log(email + ' newly found matching pubkey on PKS');
                  (window as FlowCryptWindow).flowcrypt_storage.set(account_email, { addresses_pks: addresses_pks, });
                }
              }
            }).catch((error: Error) => {
              console.log('Error fetching keys from PKS: ' + error.message);
            });
          } catch(error) {
            console.log('Error2 fetching keys from PKS: ' + error.message);
          }
        }
      }
    });
  });
}

function schedule_cryptup_subscription_level_check() {
  setTimeout(function() {
    if(get_background_process_start_reason() === 'update' || get_background_process_start_reason() === 'chrome_update') {
      // update may happen to too many people at the same time -- server overload
      setTimeout(catcher.try(tool.api.cryptup.account_check_sync), tool.time.hours(Math.random() * 3)); // random 0-3 hours
    } else {
      // the user just installed the plugin or started their browser, no risk of overloading servers
      catcher.try(tool.api.cryptup.account_check_sync)(); // now
    }
  }, 10 * 60 * 1000); // 10 minutes
  setInterval(catcher.try(tool.api.cryptup.account_check_sync), tool.time.hours(23 + Math.random())); // random 23-24 hours
}
'use strict';

const path = require('path');
const fs = require('fs-extra');
const walk = require('fs-walk');
const rimraf = require('rimraf');
const tools = require('./tools');
const plist = require('simple-plist');
const depSolver = require('./depsolver');
const plistBuild = require('plist').build;
const EventEmitter = require('events').EventEmitter;
const isEncryptedSync = require('macho-is-encrypted');
const machoEntitlements = require('macho-entitlements');

const entitlementTemplate = `
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>application-identifier</key>
	<string>FILLME.APPID</string>
	<key>com.apple.developer.team-identifier</key>
	<string>FILLME</string>
	<key>get-task-allow</key>
	<true/>
	<key>keychain-access-groups</key>
	<array>
		<string>FILLME.APPID</string>
	</array>
</dict>
</plist>
`;

function defaultEntitlements (appid, devid) {
  const ent = plist.parse(entitlementTemplate);
  console.log('appid', appid);
  console.log('devid', devid);
  ent['application-identifier'] = appid;
  ent['com.apple.developer.team-identifier'] = devid;
  ent['keychain-access-groups'] = [ appid ];
  return plistBuild(ent).toString();
}

function getResignedFilename (path) {
  if (!path) return null;
  const newPath = path.replace('.ipa', '-resigned.ipa');
  const pos = newPath.lastIndexOf(path.sep);
  if (pos !== -1) return newPath.substring(pos + 1);
  return newPath;
}

function parentDirectory (root) {
  return path.normalize(path.join(root, '..'));
}

function getExecutable (appdir, exename) {
  if (appdir) {
    const plistPath = path.join(appdir, 'Info.plist');
    const plistData = plist.readFileSync(plistPath);
    const cfBundleExecutable = plistData['CFBundleExecutable'];
    if (cfBundleExecutable) {
      return cfBundleExecutable;
    }
  }
  return exename;
}

function isMacho (buffer) {
  const magics = [
    [0xca, 0xfe, 0xba, 0xbe], // fat
    [0xce, 0xfa, 0xed, 0xfe], // 32bit
    [0xcf, 0xfa, 0xed, 0xfe], // 64bit
    [0xfe, 0xed, 0xfa, 0xce]  // big-endian
  ];
  for (let a of magics) {
    if (!buffer.compare(Buffer(a))) {
      return true;
    }
  }
  return false;
}

module.exports = class ApplesignSession {
  constructor (state, onEnd) {
    this.config = JSON.parse(JSON.stringify(state));
    this.events = new EventEmitter();
    this.events.config = this.config;
  }

  /* Event Wrapper API with cb support */
  emit (ev, msg, cb) {
    this.events.emit(ev, msg);
    if (typeof cb === 'function') {
      return cb(msg);
    }
  }

  on (ev, cb) {
    this.events.on(ev, cb);
    return this;
  }

  /* Public API */
  signIPA (cb) {
    if (typeof cb === 'function') {
      this.events.removeAllListeners('end');
      this.events.on('end', cb);
    }
    this.unzip(this.config.file, this.config.outdir, (error) => {
      if (error) { return this.emit('end', error); }
      this.signAppDirectory(this.config.outdir + '/Payload', (error, res) => {
        if (error) { return this.emit('end', error); }
        this.zip((error, res) => {
          if (error) { return this.emit('end', error); }
          this.cleanup((_) => {
            this.emit('end');
          });
        });
      });
    });
    return this;
  }

  signAppDirectory (ipadir, next) {
    if (!ipadir) {
      ipadir = path.join(this.config.outdir, 'Payload');
    }
    function isDirectory () {
      try {
        return fs.statSync(ipadir).isDirectory();
      } catch (e) {
        return false;
      }
    }
    if (!isDirectory(ipadir)) {
      return this.cleanup(() => {
        next(new Error('Cannot find ' + ipadir));
      });
    }
    this.emit('message', 'Payload found');
    const files = fs.readdirSync(ipadir).filter((x) => {
      return x.indexOf('.app') === x.length - 4;
    });
    if (files.length !== 1) {
      return next(new Error('Invalid IPA'));
    }
    this.config.appdir = path.join(ipadir, files[0]);
    const binname = getExecutable(this.config.appdir, files[0].replace('.app', ''));
    this.config.appbin = path.join(this.config.appdir, binname);
    if (fs.lstatSync(this.config.appbin).isFile()) {
      if (isEncryptedSync.path(this.config.appbin)) {
        if (!this.config.unfairPlay) {
          return next(new Error('This IPA is encrypted'));
        }
        this.emit('message', 'Main IPA executable is encrypted');
      } else {
        this.emit('message', 'Main IPA executable is not encrypted');
      }
      this.removeWatchApp(() => {
        const infoPlist = path.join(this.config.appdir, 'Info.plist');
        this.fixPlist(infoPlist, this.config.bundleid, (err) => {
          if (err) return this.events.emit('error', err, next);
          this.checkProvision(this.config.appdir, this.config.mobileprovision, (err) => {
            if (err) return this.emit('error', err, next);
            this.fixEntitlements(this.config.appbin, (err) => {
              if (err) return this.emit('error', err, next);
              this.signLibraries(this.config.appbin, this.config.appdir, (err) => {
                if (err) return this.emit('error', err, next);
                next(null, next);
              });
            });
          });
        });
      });
    } else {
      next(new Error('Invalid path'));
    }
  }

  removeWatchApp (cb) {
    if (!this.config.withoutWatchapp) {
      return cb();
    }
    const watchdir = path.join(this.config.appdir, 'Watch');
    this.emit('message', 'Stripping out the WatchApp at ' + watchdir);
    rimraf(watchdir, () => {
      const plugdir = path.join(this.config.appdir, 'PlugIns');
      this.emit('message', 'Stripping out the PlugIns at ' + plugdir);
      rimraf(plugdir, cb);
    });
  }
  /*
    TODO: verify is mobileprovision app-id glob string matches the bundleid
    read provision file in raw
    search for application-identifier and <string>...</string>
    check if prefix matches and last dot separated word is an asterisk
    const identifierInProvisioning = 'x'
    Read the one in Info.plist and compare with bundleid
  */
  checkProvision (appdir, file, next) {
    if (file && appdir) {
      this.emit('message', 'Embedding new mobileprovision');
      const mobileProvision = path.join(appdir, 'embedded.mobileprovision');
      return fs.copy(file, mobileProvision, next);
    }
    next();
  }

  adjustEntitlements (file, entMobProv, next) {
    /* TODO: check if this supports binary plist too */
    const ent = machoEntitlements.parseFile(file);
    if (ent === null) {
      return next();
    }
    const entMacho = plist.parse(ent.toString());
    let changed = false;
    ['application-identifier', 'com.apple.developer.team-identifier'].forEach((id) => {
      if (entMacho[id] !== entMobProv[id]) {
        changed = true;
        entMacho[id] = entMobProv[id];
      }
    });
    entMacho['keychain-access-groups'][0] = entMobProv['application-identifier'];
    if (changed || this.config.entry) {
      const newEntitlementsFile = file + '.entitlements';
      const appid = entMobProv['application-identifier'];
      const devid = entMobProv['com.apple.developer.team-identifier'];
      let newEntitlements = (appid && devid && this.config.entry)
        ? defaultEntitlements(appid, devid)
        : (this.config.entitlement)
          ? fs.readFileSync(this.config.entitlement)
          : plistBuild(entMacho).toString();
      fs.writeFileSync(newEntitlementsFile, newEntitlements);
      this.emit('message', 'Updated binary entitlements' + newEntitlementsFile);
      this.config.entitlement = newEntitlementsFile;
    }
    next();
  }

  fixEntitlements (file, next) {
    if (!this.config.mobileprovision) {
      const pathToProvision = path.join(this.config.appdir, 'embedded.mobileprovision');
      tools.getEntitlementsFromMobileProvision(pathToProvision, (error, newEntitlements) => {
        if (error) {
          return next();
        }
        this.emit('message', 'Grabbing entitlements from mobileprovision');
        return this.adjustEntitlements(file, newEntitlements, next);
      });
      return;
    }
    tools.getEntitlementsFromMobileProvision(this.config.mobileprovision, (error, newEntitlements) => {
      if (error) {
        return next(error);
      }
      this.emit('message', JSON.stringify(newEntitlements));
      const pathToProvision = path.join(this.config.appdir, 'embedded.mobileprovision');
      /* replace ipa's mobileprovision with given the entitlements? */
      plist.writeFileSync(pathToProvision, newEntitlements);
      this.adjustEntitlements(file, newEntitlements, next);
    });
  }

  fixPlist (file, bundleid, next) {
    const appdir = this.config.appdir;
    if (!file || !appdir) {
      return next('Invalid parameters for fixPlist');
    }
    let changed = false;
    const data = plist.readFileSync(file);
    if (this.config.forceFamily) {
      const oldSupportedDevices = data['UISupportedDevices'];
      if (oldSupportedDevices) {
        this.emit('message', 'Empty UISupportedDevices');
        delete data['UISupportedDevices'];
        changed = true;
      }
      const oldFamily = +data['UIDeviceFamily'];
      if (oldFamily === 2) {
        this.emit('message', 'UIDeviceFamily forced to iPhone');
        data['UIDeviceFamily'] = 1;
        changed = true;
      }
    }
    if (bundleid) {
      const oldBundleId = data['CFBundleIdentifier'];
      this.emit('message', 'Rebundle ' + file + ' : ' + oldBundleId + ' into ' + bundleid);
      if (oldBundleId) {
        data['CFBundleIdentifier'] = bundleid;
      }
      if (data['basebundleidentifier']) {
        data['basebundleidentifier'] = bundleid;
      }
      try {
        data['CFBundleURLTypes'][0]['CFBundleURLName'] = bundleid;
      } catch (e) {
        /* do nothing */
      }
      changed = true;
    }
    if (changed) {
      plist.writeFileSync(file, data);
    }
    next();
  }

  signFile (file, next) {
    function codesignHasFailed (config, error, errmsg) {
      if (error && error.message.indexOf('Error:')) {
        return true;
      }
      return ((errmsg && errmsg.indexOf('no identity found') !== -1) || !config.ignoreCodesignErrors);
    }
    tools.codesign(this.config.identity, this.config.entitlement, this.config.keychain, file, (error, stdout, stderr) => {
      this.emit('message', 'Signed ' + file);
      if (error && codesignHasFailed(this.config, error, stderr)) {
        return this.emit('end', error, next);
      }
      if (this.config.verifyTwice) {
        this.emit('message', 'Verify ' + file);
        tools.verifyCodesign(file, this.config.keychain, (error, stdout, stderr) => {
          if (error) {
            if (this.config.ignoreVerificationErrors) {
              return this.emit('warning', error, next);
            }
            return this.emit('error', error, next);
          }
          next(undefined, error);
        });
      } else {
        next(undefined, error);
      }
    });
    return this;
  }

  signLibraries (bpath, appdir, next) {
    this.emit('message', 'Signing libraries and frameworks');

    const libraries = [];
    const exe = path.sep + getExecutable(this.config.appdir);

    let found = false;
    walk.walkSync(appdir, (basedir, filename, stat) => {
      const file = path.join(basedir, filename);
      if (file.endsWith(exe)) {
        this.emit('message', 'Executable found at ' + file);
        libraries.push(file);
        found = true;
        return;
      }
      if (!fs.lstatSync(file).isFile()) {
        return;
      }
      try {
        const fd = fs.openSync(file, 'r');
        let buffer = new Buffer(4);
        fs.readSync(fd, buffer, 0, 4);
        if (isMacho(buffer)) {
          libraries.push(file);
        }
        fs.close(fd);
      } catch (e) {
        console.error(basedir, filename, e);
        next(e);
      }
    });
    if (!found) {
      next('Cannot find any MACH0 binary to sign');
    }

    const parallelVerify = (libs, next) => {
      let depsCount = libs.length;
      for (let lib of libs) {
        this.emit('message', 'Verifying ' + lib);
        tools.verifyCodesign(lib, null, (err) => {
          if (--depsCount === 0) {
            next(err);
          }
        });
      }
    };

    const layeredSigning = (libs, next) => {
      let libsCopy = libs.slice(0).reverse();
      const peel = () => {
        if (libsCopy.length === 0) {
          return parallelVerify(libraries, next);
        }
        const deps = libsCopy.pop();
        let depsCount = deps.length;
        for (let d of deps) {
          this.signFile(d, () => {
            if (--depsCount === 0) {
              peel();
            }
          });
        }
      };
      peel();
    };

    const serialSigning = (libs, next) => {
      let libsCopy = libs.slice(0).reverse();
      const peek = (cb) => {
        if (libsCopy.length === 0) {
          libsCopy = libs.slice(0);
          return cb();
        }
        const lib = libsCopy.pop();
        this.signFile(lib, () => {
          peek(cb);
        });
      };
      peek(() => {
        libsCopy = libs.slice(0);
        const verify = (cb) => {
          if (libsCopy.length === 0) {
            return cb();
          }
          const lib = libsCopy.pop();
          this.emit('message', 'Verifying ' + lib);
          tools.verifyCodesign(lib, null, () => {
            verify(cb);
          });
        };
        verify(next);
      });
    };

    this.emit('message', 'Resolving signing order using layered list');
    depSolver(bpath, libraries, this.config.parallel, (err, libs) => {
      if (err) { return next(err); }
      if (libs.length === 0) {
        libs.push(bpath);
      }
      if (typeof libs[0] === 'object') {
        return layeredSigning(libs, next);
      }
      return serialSigning(libs, next);
    });
  }

  cleanup (cb) {
    const outdir = this.config.outdir;
    this.emit('message', 'Cleaning up ' + outdir);
    try {
      rimraf(outdir, cb);
    } catch (e) {
      this.emit('message', e);
    }
  }

  zip (next) {
    function getOutputPath (cwd, ofile) {
      if (ofile.startsWith(path.sep)) {
        return ofile;
      }
      return path.join(parentDirectory(cwd), ofile);
    }
    const ipaIn = this.config.file;
    const ipaOut = getOutputPath(this.config.outdir, this.config.outfile);
    try {
      fs.unlinkSync(ipaOut);
    } catch (e) {
      /* do nothing */
    }
    const continuation = () => {
      this.events.emit('message', 'Zipifying into ' + ipaOut + ' ...');
      tools.zip(this.config.outdir, ipaOut, 'Payload', (error) => {
        if (!error && this.config.replaceipa) {
          this.events.emit('message', 'mv into ' + ipaIn);
          return fs.rename(ipaOut, ipaIn, next);
        }
        next(error);
      });
    };
    if (this.config.withoutWatchapp) {
      const watchdir = path.join(this.config.appdir, 'Watch');
      this.emit('message', 'Stripping out the WatchApp: ' + watchdir);
      rimraf(watchdir, () => {
        const plugdir = path.join(this.config.appdir, 'PlugIns');
        rimraf(plugdir, continuation);
      });
    } else {
      continuation();
    }
  }

  setFile (name) {
    if (typeof name === 'string') {
      this.config.file = path.resolve(name);
      this.config.outdir = this.config.file + '.d';
      if (!this.config.outfile) {
        this.setOutputFile(getResignedFilename(this.config.file));
      }
    }
  }

  setOutputFile (name) {
    this.config.outfile = name;
  }

  /* TODO: move to tools.js */
  unzip (file, outdir, cb) {
    if (!file || !outdir) {
      return cb(new Error('No output specified'));
    }
    if (!outdir) {
      return cb(new Error('Invalid output directory'));
    }
    this.events.emit('message', ['rm -rf', outdir].join(' '));
    this.cleanup(() => {
      this.events.emit('message', 'Unzipping ' + file);
      tools.unzip(file, outdir, (error, stdout) => {
        if (error) {
          this.cleanup(() => { cb(error); });
        } else {
          cb(undefined, stdout);
        }
      });
    });
  }
};

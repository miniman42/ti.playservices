/**
 * Axway Appcelerator Titanium - ti.playservices
 * Copyright (c) 2018-Present by Axway. All Rights Reserved.
 * Licensed under the terms of the Apache Public License
 * Please see the LICENSE included with this distribution for details.
 */

const request = require('request');
const rp = require('request-promise');
const cheerio = require('cheerio');
const fs = require('fs-extra');
const path = require('path');
const ssri = require('ssri');

const repository = 'https://mvnrepository.com/artifact/com.google.android.gms';

// obtain list from repository
async function getList (url) {
    const options = {
        uri: url,
        transform: (body) => {
            return cheerio.load(body);
        }
    };
    let list = [];
    await rp(options)
        .then(async ($) => {

            // get libraries
            $('.im-title').each((i, element) => {
                const href = $(element.children[1]).attr('href').split('/')[1];
                list.push(href);
            });

            // navigate to next page
            const next = $('.search-nav').children().last();
            if (!next.hasClass('current')) {
                const nextPage = next.children().last().attr('href');
                list = list.concat(await getList(repository + nextPage));
            }
        });

    return list;
}

// obtain latest version of library
async function getLatestVersion (url) {
    const options = {
        uri: url,
        transform: (body) => {
            return cheerio.load(body);
        }
    };
    let version = undefined;
    await rp(options)
        .then(async ($) => {
            $('.release').each((i, element) => {
                const href = $(element).attr('href').split('/')[1];
                version = href;
                return false;
            });
        });

    return version;
}

// obtain list of files
async function getFiles (url, filter) {
    const options = {
        uri: url,
        transform: (body) => {
            return cheerio.load(body);
        }
    };
    let list = [];
    await rp(options)
        .then(async ($) => {
            $('.vbtn').each((i, element) => {
                const href = $(element).attr('href');
                if (href) {
                    const type = href.split('.').pop();
                    if (filter) {
                        if (filter.includes(type)) {
                            list.push(href);
                        }
                    } else {
                        list.push(href);
                    }
                }
            });
        });

    return list;
}

/**
 * @param {string} repository maven repository to query
 */
async function gatherLibraries(repository) {
    // obtain Google Play Services repository libraries
    const libraries = await getList(repository);
    const blacklist = [
        'play-services-contextmanager',
        'play-services-measurement',
        'play-services-instantapps',
        'play-services-vision',
        'play-services-vision-common',
        'play-services-drive',
        'play-services-plus',
        'play-services-wearable',
        'play-services-games',
        'play-services-cast-framework',
        'play-services-appinvite',
        'play-services-appindexing',
        'play-services-all-wear',
        'play-services-fido',
        'play-services-gass',
        'play-services-tagmanager',
        'play-services-awareness',
        'play-services-clearcut',
        'play-services-ads',
        'play-services-ads-lite',
        'play-services-ads-identifier',
        'play-services-ads-base',
        'play-services-phenotype',
        'play-services-vision-image-label',
        'play-services-tagmanager-v4-impl',
        'play-services-tagmanager-api',
        'play-services-afs-native',
        'play-services'
    ];

    // filter valid libraries
    return libraries.filter(library => {
        return library.startsWith('play-') && !library.endsWith('license') && !blacklist.includes(library);
    });
}

/**
 *
 * @param {string} destDir directory to place the downloaded AAR files
 * @param {string} repository name of maven repository
 * @param {string} library name of google library
 * @param {string} [version='latest'] version to download. defaults to 'latest'. 'latest' will grab latest from maven repository.
 * @returns {Promise<string} url of downloaded library/aar
 */
async function downloadLibrary(destDir, repository, library, version = 'latest') {
    if (!version || version === 'latest') {
        // obtain latest version of library
        version = await getLatestVersion(`${repository}/${library}?repo=google`);
    }

    // obtain library .aar
    const archives = await getFiles(`${repository}/${library}/${version}`, 'aar');
    if (archives.length !== 1) {
        throw new Error(`Expected single URL to download library: ${library}/${version}, but got: ${archives}`);
    }
    const url = archives[0];
    const name = `${library}-${version}.aar`;
    const destination = path.join(destDir, name);
    // download aar
    await download(url, destination);
    // Add a sha/hash/integrity value?
    const hash = await ssri.fromStream(fs.createReadStream(destination));
    return {
        url,
        name,
        integrity: hash.toString()
    };
}

/**
 * Downloads a file to a destination path.
 * @param {string} url URL to download
 * @param {string} dest destination file path
 */
async function download(url, dest) {
    console.log(`  ${dest}`);
    return new Promise((resolve, reject) => {
        const writable = fs.createWriteStream(dest);
        const readable = request(url).pipe(writable);
        writable.on('finish', () => resolve(dest));
        readable.on('error', reject);
        writable.on('error', reject);
    });
}

/**
 * Downloads a file and verifies the integrity hash matches (or throws)
 * @param {string} url URL to download
 * @param {string} downloadPath path to save the file
 * @param {string} integrity ssri integrity hash value to confirm contents
 * @return {Promise<string>} the path to the downloaded (and verified) file
 */
async function downloadWithIntegrity(url, downloadPath, integrity) {
	const file = await download(url, downloadPath);

	// Verify integrity!
	await ssri.checkStream(fs.createReadStream(file), integrity);
	return file;
}

/**
 * If necessary, downloads the given url and verifies the integrity hash. If the file already exists, verifies the integrity hash.
 * If teh file exists and fails the integrity check, re-downloads from URL and verifies integrity hash.
 * @param {string} url URL to download
 * @param {string} destination where to save the file
 * @param {string} integrity ssri integrity hash
 * @returns {Promise<string>} path to file
 */
async function downloadIfNecessary(url, destination, integrity) {
	if (!integrity) {
		throw new Error(`No "integrity" value given for ${url}, may need to run "upgrade" to generate new library listing with updated integrity hashes.`);
	}

	// Check if file already exists and passes integrity check!
	if (await fs.exists(destination)) {
		try {
			// if it passes integrity check, we're all good, return path to file
			await ssri.checkStream(fs.createReadStream(destination), integrity);
			// cached copy is still valid, integrity hash matches
			return destination;
		} catch (e) {
			// hash doesn't match. Wipe the cached version and re-download
			await fs.remove(destination);
			return downloadWithIntegrity(url, destination, integrity);
		}
	}

	// download and verify integrity
	return downloadWithIntegrity(url, destination, integrity);
};

/**
 * Grab the latest versions of all the libraries, download them, update our lockfile
 */
async function upgrade() {
    console.log(`Obtaining latest Play Services libraries...`);
    const libraries = await gatherLibraries(repository);
    const destDir = path.join(__dirname, '../android/lib/');
    await fs.emptyDir(destDir);
    const downloaded = await Promise.all(libraries.map(l => downloadLibrary(destDir, repository, l)));
    return fs.writeJSON(path.join(__dirname, 'libraries-lock.json'), downloaded, { spaces: '\t' });
}

/**
 * Grab the exact versions of the libraries we've got written in our lockfile
 */
async function ci() {
    console.log(`Obtaining Play Services libraries from lockfile...`);
    const json = await fs.readJSON(path.join(__dirname, 'libraries-lock.json'));
    const destDir = path.join(__dirname, '../android/lib/');
    await fs.emptyDir(destDir);
    return Promise.all(json.map(l => downloadIfNecessary(l.url, path.join(destDir, l.name), l.integrity)));
}

(async function main() {
    if (process.argv.length >= 3 && process.argv[2] == 'upgrade') {
        return upgrade();
    }
    return ci();
})();

/* Amplify Params - DO NOT EDIT
	ENV
	REGION
Amplify Params - DO NOT EDIT */
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');
const Papa = require('papaparse');
const _ = require('lodash');
const axios = require('axios');
const { DateTime } = require('luxon');

const BUCKET_ID = 'is-smm-beaten-yet-public-data';
const CLEARS_SPREADSHEET_ID = '1PMNsDoZqYd4261FRmEZSo3SkcnqcvfbKDTQMAJaw6ws';
const UNCLEARED_SHEET_ID = '11dV6SHOIBzHjIqacQyG8Hsnynydg3h7MBLsFoDwA5KA';

function getSheetDownloadUrl(sheetId, sheetName) {
  return `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(
    sheetName,
  )}`;
}

const COMMON_TITLE_TO_KEY = {
  Title: 'title',
  'Upload Date': 'uploadDate',
  Stars: 'stars',
  Players: 'players',
  Attempts: 'attempts',
  Creator: 'creator',
  'Level ID': 'levelId',
};

const UNCLEARED_TITLE_TO_KEY = {
  ...COMMON_TITLE_TO_KEY,
  Code: 'countryCode',
  Style: 'style',
  Theme: 'theme',
  AutoScroll: 'autoscroll',
  Hacked: 'hacked',
  Timer: 'timer',
};

const CLEARED_TITLE_TO_KEY = {
  ...COMMON_TITLE_TO_KEY,
  'First Clearer NNID': 'firstClearerNnid',
  'Date Cleared': 'dateCleared',
};

// known hackers. no soup for you
const BANNED_NNIDS = new Set(['Zappy7', 'BechPlayz69']);

async function getS3File(s3, filename) {
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: BUCKET_ID,
      Key: filename,
    }),
  );
  const chunks = [];
  for await (const chunk of response.Body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

async function uploadToS3(s3, filename, data) {
  await s3.send(
    new PutObjectCommand({
      Body: JSON.stringify(data),
      Bucket: BUCKET_ID,
      Key: filename,
      Metadata: {
        'Content-Type': 'application/json',
      },
    }),
  );
}

async function downloadCsv(downloadUrl, transformer) {
  const { data } = await axios.get(downloadUrl);

  return new Promise((resolve, reject) => {
    Papa.parse(data, {
      header: true,
      transformHeader: (title) => transformer[title] ?? title,
      complete: ({ data }) => resolve(data),
      error: (e) => reject(e),
    });
  });
}

function cleanList(levels, allowedProps) {
  return levels.map((level) => _.pick(level, allowedProps));
}

function parseDate(date) {
  return DateTime.fromFormat(date, 'DDD').toISODate();
}

function parseLevelCommon(level) {
  const hasValue = (v) => !_.isNil(v) && v !== '';

  return {
    stars: hasValue(level.stars)
      ? parseInt(level.stars.replace(/[^\d]/g, ''), 10)
      : level.stars,
    players: hasValue(level.players)
      ? parseInt(level.players.replace(/[^\d]/g, ''), 10)
      : level.players,
    clears: hasValue(level.clears)
      ? parseInt(level.clears.replace(/[^\d]/g, ''), 10)
      : level.clears,
    attempts: hasValue(level.attempts)
      ? parseInt(level.attempts.replace(/[^\d]/g, ''), 10)
      : level.attempts,
    uploadDate: parseDate(level.uploadDate),
  };
}

/**
 * @type {import('@types/aws-lambda').APIGatewayProxyHandler}
 */
exports.handler = async (event) => {
  console.log(`EVENT: ${JSON.stringify(event)}`);

  console.log('Init S3');
  const s3 = new S3Client();

  console.log('Queue static GETs');
  const legacyClearsPromise = getS3File(s3, 'static/legacy_clears.json');

  const levelMetaPromise = getS3File(s3, 'static/static_level_data.json');
  const translationsPromise = getS3File(s3, 'static/jp_en_translations.json');
  const uploadOverridesPromise = getS3File(
    s3,
    'static/upload_date_overrides.json',
  );

  console.log('Downloading gsheets');
  const [unclearedLevels, clearedLevels] = await Promise.all([
    downloadCsv(
      getSheetDownloadUrl(UNCLEARED_SHEET_ID, 'By Date'),
      UNCLEARED_TITLE_TO_KEY,
    ),
    downloadCsv(
      getSheetDownloadUrl(CLEARS_SPREADSHEET_ID, 'Cleared Levels'),
      CLEARED_TITLE_TO_KEY,
    ),
  ]);

  const unclearedClean = cleanList(
    unclearedLevels,
    Object.values(UNCLEARED_TITLE_TO_KEY),
  );
  const clearedClean = cleanList(
    clearedLevels,
    Object.values(CLEARED_TITLE_TO_KEY),
  );

  console.log('Compiling uncleared levels');
  const translations = JSON.parse(await translationsPromise);

  const getLevelTranslation = (level) =>
    level.countryCode === 'JP' || level.hacked
      ? { titleTranslation: translations[level.levelId] }
      : {};

  const unclearedFinal = _.sortBy(
    unclearedClean.map((level) => ({
      ...level,
      ...parseLevelCommon(level),
      ...getLevelTranslation(level),
      hacked: Boolean(level.hacked),
      autoscroll: Boolean(level.autoscroll),
      timer: parseInt(level.timer, 10),
    })),
    'uploadDate',
  );

  console.log('Compiling cleared levels');
  const uploadDateOverrides = JSON.parse(await uploadOverridesPromise);
  const levelMeta = JSON.parse(await levelMetaPromise);

  const getLevelMeta = (level) => _.omit(levelMeta[level.levelId], 'id');
  const getClearDate = (level) => {
    if (level.levelId in uploadDateOverrides) {
      return {
        dateCleared: uploadDateOverrides[level.levelId],
        clearDateEstimated: true,
      };
    }
    return {
      dateCleared: parseDate(level.dateCleared),
    };
  };

  const joinedClears = clearedClean
    .map((level) => ({
      ...level,
      ...parseLevelCommon(level),
      ...getLevelMeta(level),
      ...getClearDate(level),
    }))
    .concat(JSON.parse(await legacyClearsPromise));

  const clearedFinal = _.uniqBy(
    _.sortBy(
      joinedClears.filter(({ creator }) => !BANNED_NNIDS.has(creator)),
      'dateCleared',
    ),
    'levelId',
  );

  const filteredClearCount = joinedClears.length - clearedFinal.length;
  console.log('Removed', filteredClearCount, 'cleared from banned NNIDs');

  console.log(
    'UNCLEARED:',
    unclearedFinal.length,
    unclearedFinal[0],
    unclearedFinal[Math.round((unclearedFinal.length - 1) / 2)],
    unclearedFinal[unclearedFinal.length - 1],
  );
  console.log(
    'CLEARED:',
    clearedFinal.length,
    clearedFinal[0],
    clearedFinal[Math.round((clearedFinal.length - 1) / 2)],
    clearedFinal[clearedFinal.length - 1],
  );

  if (!event.localrun) {
    await Promise.all([
      uploadToS3(s3, 'levels/uncleared.json', unclearedFinal),
      uploadToS3(s3, 'levels/cleared.json', clearedFinal),
    ]);
  } else {
    console.log('Skipping S3 upload due to local run');
  }

  console.log('Creating clear summary data');

  const clearsByDate = _.mapValues(
    _.groupBy(clearedFinal, 'dateCleared'),
    'length',
  );

  const getWinner = (levels) => {
    const clearsByCreator = _.countBy(levels, 'firstClearerNnid');
    const ranked = _.orderBy(_.toPairs(clearsByCreator), '1', 'desc');
    const winners = _.takeWhile(
      ranked,
      ([_, levels]) => levels === ranked[0][1],
    );
    return {
      creators: _.map(winners, '0'),
      levels: winners[0][1],
    };
  };

  const dailyWinners = _.mapValues(
    _.groupBy(clearedFinal, 'dateCleared'),
    getWinner,
  );

  const weeklyWinners = _.mapValues(
    _.groupBy(clearedFinal, ({ dateCleared }) =>
      DateTime.fromISO(dateCleared).startOf('week').toISOWeekDate(),
    ),
    getWinner,
  );

  const clearsByPerson = _.mapValues(
    _.groupBy(clearedFinal, 'firstClearerNnid'),
    'length',
  );

  const clearStats = {
    clearsByDate,
    clearsByPerson,
    winners: {
      daily: dailyWinners,
      weekly: weeklyWinners,
    },
    clearedTotal: clearedFinal.length,
  };

  if (!event.localrun) {
    await uploadToS3(s3, 'levels/clear_summary.json', clearStats);
  } else {
    console.log('Skipping S3 upload due to local run');
  }

  return {
    statusCode: 200,
    body: {
      processedUncleareds: unclearedClean.length,
      processedCleareds: clearedLevels.length,

      totalUncleared: unclearedFinal.length,
      totalCleared: clearedFinal.length,

      filteredClears: filteredClearCount,
    },
  };
};

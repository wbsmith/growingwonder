const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { ulid } = require('ulid');

const region = process.env.WIW_AWS_REGION || process.env.AWS_REGION || 'us-west-1';
const BUCKET = process.env.WIW_S3_BUCKET || 'wiw-media-assets';

const clientConfig = { region };
if (process.env.WIW_ACCESS_KEY_ID) {
  clientConfig.credentials = {
    accessKeyId: process.env.WIW_ACCESS_KEY_ID,
    secretAccessKey: process.env.WIW_SECRET_ACCESS_KEY,
  };
}
const s3 = new S3Client(clientConfig);

const BASE_URL = `https://${BUCKET}.s3.${region}.amazonaws.com`;

async function getUploadUrl(programId, filename, contentType) {
  const ext = filename.split('.').pop().toLowerCase();
  const key = `programs/${programId}/${ulid()}.${ext}`;
  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
  });
  const url = await getSignedUrl(s3, cmd, { expiresIn: 300 });
  return { uploadUrl: url, key, publicUrl: `${BASE_URL}/${key}` };
}

async function deleteFile(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

module.exports = { getUploadUrl, deleteFile, BASE_URL };

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';

const scrypt = promisify(crypto.scrypt);
const storageDir = path.join(process.cwd(), 'data');
const accessFile = path.join(storageDir, 'user-access.json');
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PASSWORD_LENGTH = 10;

function emptyState() {
  return { users: [] };
}

async function readState() {
  try {
    const content = await fs.readFile(accessFile, 'utf-8');
    const parsed = JSON.parse(content);
    return {
      users: Array.isArray(parsed?.users) ? parsed.users : [],
    };
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw error;
  }
}

async function writeState(state) {
  await fs.mkdir(storageDir, { recursive: true });
  const temp = accessFile + '.tmp';
  await fs.writeFile(temp, JSON.stringify(state, null, 2));
  await fs.rename(temp, accessFile);
}

function generatePassword() {
  let password = '';
  for (let index = 0; index < PASSWORD_LENGTH; index += 1) {
    password += PASSWORD_ALPHABET[crypto.randomInt(0, PASSWORD_ALPHABET.length)];
  }
  return password;
}

async function hashPassword(password, salt) {
  const result = await scrypt(String(password), salt, 32);
  return Buffer.from(result).toString('base64url');
}

function safeUser(user) {
  return {
    id: String(user.id || ''),
    label: String(user.label || 'Kullanici'),
    createdAt: String(user.createdAt || ''),
    lastLoginAt: String(user.lastLoginAt || ''),
  };
}

export async function listAccessUsers() {
  const state = await readState();
  return {
    users: state.users.map(safeUser),
    total: state.users.length,
  };
}

export async function createAccessUser(label = '') {
  const state = await readState();
  const password = generatePassword();
  const salt = crypto.randomBytes(18).toString('base64url');
  const id = 'usr_' + crypto.randomBytes(10).toString('hex');
  const createdAt = new Date().toISOString();
  const userLabel = String(label || '').trim() || ('Kullanici ' + (state.users.length + 1));

  state.users.push({
    id,
    label: userLabel.slice(0, 80),
    salt,
    passwordHash: await hashPassword(password, salt),
    createdAt,
    lastLoginAt: '',
  });

  await writeState(state);

  return {
    user: safeUser(state.users[state.users.length - 1]),
    password,
  };
}

export async function authenticateAccessUser(password) {
  const candidate = String(password || '').trim();
  if (!candidate) return null;

  const state = await readState();

  for (const user of state.users) {
    if (!user?.salt || !user?.passwordHash || !user?.id) continue;

    const candidateHash = await hashPassword(candidate, user.salt);
    const left = Buffer.from(candidateHash);
    const right = Buffer.from(String(user.passwordHash));

    if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) continue;

    user.lastLoginAt = new Date().toISOString();
    await writeState(state);
    return safeUser(user);
  }

  return null;
}

export async function accessUserExists(userId) {
  const id = String(userId || '').trim();
  if (!id) return false;
  const state = await readState();
  return state.users.some((user) => String(user?.id || '') === id);
}

export async function revokeAccessUser(userId) {
  const id = String(userId || '').trim();
  const state = await readState();
  const before = state.users.length;
  state.users = state.users.filter((user) => String(user?.id || '') !== id);

  if (state.users.length === before) {
    const error = new Error('Kullanici bulunamadi.');
    error.status = 404;
    throw error;
  }

  await writeState(state);
  return listAccessUsers();
}

// Run by hand to create a test account: no request runs it.
import bcrypt from 'bcryptjs';
import { store } from '../src/store.js';

await store.saveUser({ email: 'test@example.com', legacyHash: bcrypt.hashSync('test password', 12) });

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import test from 'node:test';
import os from 'node:os';

const root = fileURLToPath(new URL('..', import.meta.url));

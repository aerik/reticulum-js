import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { parseJsonConfig, parseIniConfig, loadConfig, generateDefaultIniConfig, DEFAULT_CONFIG } from '../src/utils/config.js';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

describe('Config parsing', () => {
  describe('parseJsonConfig', () => {
    it('parses a basic JSON config', () => {
      const config = parseJsonConfig(JSON.stringify({
        reticulum: { enable_transport: true },
        interfaces: [
          { name: 'Test TCP', type: 'TCPClientInterface', enabled: true, target_host: 'example.com', target_port: 4242 },
        ],
      }));

      expect(config.reticulum.enable_transport).toBe(true);
      expect(config.reticulum.shared_instance_port).toBe(37428); // default filled in
      expect(config.interfaces).toHaveLength(1);
      expect(config.interfaces[0].target_host).toBe('example.com');
    });

    it('fills in defaults for missing keys', () => {
      const config = parseJsonConfig('{}');
      expect(config.reticulum.enable_transport).toBe(false);
      expect(config.logging.loglevel).toBe(4);
      expect(config.interfaces).toEqual([]);
    });
  });

  describe('parseIniConfig', () => {
    it('parses Python-style INI config', () => {
      const ini = `
[reticulum]
  enable_transport = True
  share_instance = Yes
  shared_instance_port = 37428

[logging]
  loglevel = 6

[interfaces]
  [[Dublin TCP]]
    type = TCPClientInterface
    enabled = Yes
    target_host = rns.beleth.net
    target_port = 4242

  [[Local UDP]]
    type = UDPInterface
    enabled = No
    listen_port = 5555
`;

      const config = parseIniConfig(ini);

      expect(config.reticulum.enable_transport).toBe(true);
      expect(config.reticulum.share_instance).toBe(true);
      expect(config.logging.loglevel).toBe(6);
      expect(config.interfaces).toHaveLength(2);

      expect(config.interfaces[0].name).toBe('Dublin TCP');
      expect(config.interfaces[0].type).toBe('TCPClientInterface');
      expect(config.interfaces[0].enabled).toBe(true);
      expect(config.interfaces[0].target_host).toBe('rns.beleth.net');
      expect(config.interfaces[0].target_port).toBe(4242);

      expect(config.interfaces[1].name).toBe('Local UDP');
      expect(config.interfaces[1].enabled).toBe(false);
    });

    it('handles comments and blank lines', () => {
      const ini = `
# This is a comment
[reticulum]
  enable_transport = False  # inline comment

[interfaces]
`;
      const config = parseIniConfig(ini);
      expect(config.reticulum.enable_transport).toBe(false);
    });

    it('parses boolean values (True/False/Yes/No/On/Off)', () => {
      const ini = `
[reticulum]
  enable_transport = True
  share_instance = yes
`;
      const config = parseIniConfig(ini);
      expect(config.reticulum.enable_transport).toBe(true);
      expect(config.reticulum.share_instance).toBe(true);
    });

    it('parses IFAC config on interfaces', () => {
      const ini = `
[interfaces]
  [[Secure TCP]]
    type = TCPClientInterface
    enabled = Yes
    target_host = example.com
    target_port = 4242
    networkname = my-private-net
    passphrase = super-secret
`;
      const config = parseIniConfig(ini);
      expect(config.interfaces[0].networkname).toBe('my-private-net');
      expect(config.interfaces[0].passphrase).toBe('super-secret');
    });
  });

  describe('generateDefaultIniConfig', () => {
    it('produces valid parseable INI', () => {
      const ini = generateDefaultIniConfig();
      const config = parseIniConfig(ini);
      expect(config.reticulum.enable_transport).toBe(false);
      expect(config.interfaces).toHaveLength(1);
      expect(config.interfaces[0].type).toBe('AutoInterface');
    });
  });

  describe('loadConfig', () => {
    let tempDir;

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'rns-config-'));
    });

    afterAll(async () => {
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('loads JSON config when present', async () => {
      await writeFile(join(tempDir, 'config.json'), JSON.stringify({
        reticulum: { enable_transport: true },
        interfaces: [{ name: 'Test', type: 'TCPClientInterface', enabled: true }],
      }));

      const config = await loadConfig(tempDir);
      expect(config.reticulum.enable_transport).toBe(true);
      expect(config.interfaces).toHaveLength(1);
    });

    it('falls back to INI config', async () => {
      await writeFile(join(tempDir, 'config'), `
[reticulum]
  enable_transport = True
[interfaces]
`);

      const config = await loadConfig(tempDir);
      expect(config.reticulum.enable_transport).toBe(true);
    });

    it('generates default config when none exists', async () => {
      const emptyDir = join(tempDir, 'empty');
      await mkdir(emptyDir, { recursive: true });
      const config = await loadConfig(emptyDir);
      expect(config.reticulum.enable_transport).toBe(false);
    });
  });
});

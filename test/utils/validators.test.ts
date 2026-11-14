import { describe, expect, test } from '@jest/globals';
import {
  isValidUsername,
  isValidEmail,
  isValidPassword,
  isValidMCPServer,
  isValidMCPServerKey,
} from '../../src/utils/validators';

describe('utils/validators', () => {
  describe('isValidUsername', () => {
    test.each([
      ['你好', 'valid Chinese characters'],
      ['Jack', 'valid alphabetic characters'],
      ['Jack.Tom', 'valid dot separator in the middle'],
      ['1123', 'valid numeric characters'],
    ])('returns true for "%s" (%s)', (username) => {
      expect(isValidUsername(username)).toBe(true);
    });

    test.each([
      ['你', 'too short (1 character)'],
      ['123456789098765432101', 'too long (exceeds max length)'],
      ['    ', 'whitespace only'],
      ['.Jack', 'starts with a dot'],
      ['Jack.', 'ends with a dot'],
      ['Jack.Tom.', 'ends with a trailing dot'],
      ['Jack-', 'ends with a hyphen'],
      ['Jack-1', 'contains a hyphen'],
      ['<Jack>', 'contains angle brackets'],
      ['Ross*Jack', 'contains an asterisk'],
      ['Ross*T', 'contains an asterisk before a single character'],
      ['Ross&Jack', 'contains an ampersand'],
      ["Ross'd", 'contains a single straight quote'],
      ['Ross"d', 'contains a double straight quote'],
      ['Ross‘Jack', 'contains a single curly quote'],
      ['Ross“Jack', 'contains a double curly quote'],
      ['Ross+Jack', 'contains a plus sign'],
      ['Ross?', 'contains a question mark'],
    ])('returns false for "%s" (%s)', (username) => {
      expect(isValidUsername(username)).toBe(false);
    });
  });

  describe('isValidEmail', () => {
    test.each([
      ['you@company.com', 'standard email'],
      ['you+23@company.cn', 'email with plus alias'],
      ['you@company.co', 'two-letter top-level domain'],
      ['name.lastname@company.com', 'dot in local part'],
      ['you@company.com.cn', 'multi-part domain'],
    ])('returns true for "%s" (%s)', (email) => {
      expect(isValidEmail(email)).toBe(true);
    });

    test.each([
      ['you@company', 'missing top-level domain'],
      ['you@@company.com', 'consecutive @ symbols'],
      ['@company', 'missing local part and TLD'],
      ['company', 'missing @ symbol and domain'],
      ['you@name@compan.com', 'multiple @ symbols'],
    ])('returns false for "%s" (%s)', (email) => {
      expect(isValidEmail(email)).toBe(false);
    });
  });

  describe('isValidPassword', () => {
    test.each([
      ['WX1342', 'uppercase letters and numbers meeting min length'],
      ['Gd2303', 'mixed-case letters and numbers meeting min length'],
    ])('returns true for "%s" (%s)', (password) => {
      expect(isValidPassword(password)).toBe(true);
    });

    test.each([
      ['WX134', 'too short (5 characters)'],
      ['Pass12345678909876541', 'too long (21 characters)'],
      ['134423', 'numbers only'],
      ['ewjfhsdakjh', 'letters only'],
    ])('returns false for "%s" (%s)', (password) => {
      expect(isValidPassword(password)).toBe(false);
    });
  });

  describe('isValidMCPServer', () => {
    const baseServerConfig = {
      name: 'AMap',
      command: 'npx',
      description: 'MCP Server for AMap (GaoDe Map)',
      env: {
        AMAP_MAPS_API_KEY:
          '{{amapKey@string::got it from https://lbs.amap.com/api/mcp-server/create-project-and-key }}',
      },
      homepage: 'https://lbs.amap.com/api/mcp-server/summary',
    };

    test('returns true for a complete valid server configuration with args', () => {
      const serverWithArgs = {
        ...baseServerConfig,
        args: ['-y', '@amap/amap-maps-mcp-server'],
      };

      expect(isValidMCPServer(serverWithArgs)).toBe(true);
    });

    test('returns true for a valid server configuration without optional args', () => {
      expect(isValidMCPServer(baseServerConfig)).toBe(true);
    });

    test('returns false when args is not an array', () => {
      const invalidServer = {
        name: 'InvalidServer',
        command: 'invalid-command',
        args: 'not-an-array',
      };

      expect(isValidMCPServer(invalidServer)).toBe(false);
    });
  });

  describe('isValidMCPServerKey', () => {
    test.each([
      ['AMap', 'alphanumeric PascalCase'],
      ['valid-key', 'lowercase words separated by a single hyphen'],
      ['invalid-key-1', 'lowercase words ending with a hyphen and number'],
      ['invalid-key-1-2', 'multiple hyphen-separated segments'],
    ])('returns true for "%s" (%s)', (key) => {
      expect(isValidMCPServerKey(key)).toBe(true);
    });

    test.each([
      ['invalid-key-', 'trailing hyphen'],
      ['invalid-key--1', 'consecutive hyphens'],
      ['invalid-key-1-', 'trailing hyphen after number'],
    ])('returns false for "%s" (%s)', (key) => {
      expect(isValidMCPServerKey(key)).toBe(false);
    });
  });
});

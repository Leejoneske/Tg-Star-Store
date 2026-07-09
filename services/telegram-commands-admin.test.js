const registerAdminEmailCommands = require('./telegram-commands-admin');

describe('registerAdminEmailCommands', () => {
  it('exports a function', () => {
    expect(typeof registerAdminEmailCommands).toBe('function');
  });

  it('skips registration when bot is missing', () => {
    expect(registerAdminEmailCommands(null, [], {})).toBeUndefined();
  });
});

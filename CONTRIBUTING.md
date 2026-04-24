# Contributing to StarStore

Thank you for your interest in contributing to StarStore! This document provides guidelines and instructions for contributing to the project.

## Code of Conduct

We are committed to providing a welcoming and inclusive environment for all contributors. Please read and follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## How to Contribute

### Reporting Bugs

Before creating a bug report, please check the GitHub Issues to avoid duplicates.

When creating a bug report, include:
- A clear title and description
- Steps to reproduce the issue
- Expected behavior vs. actual behavior
- Screenshots or error logs (if applicable)
- Your environment (Node.js version, OS, browser if frontend-related)

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub Issues. When suggesting an enhancement:
- Use a clear descriptive title
- Provide a detailed description of the proposed enhancement
- Explain why this enhancement would be useful
- List alternative solutions you've considered

### Pull Requests

1. **Fork the Repository**
   ```bash
   git clone https://github.com/your-username/Tg-Star-Store.git
   cd Tg-Star-Store
   ```

2. **Create a Feature Branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

3. **Make Your Changes**
   - Follow the code style guidelines (see below)
   - Ensure your code works locally
   - Add tests for new functionality
   - Update documentation as needed

4. **Test Your Changes**
   ```bash
   npm test
   npm run test:coverage
   ```

5. **Commit Your Changes**
   ```bash
   git commit -m "feat: Add your feature description"
   ```
   
   Use conventional commits:
   - `feat:` for new features
   - `fix:` for bug fixes
   - `docs:` for documentation
   - `style:` for formatting
   - `refactor:` for code refactoring
   - `test:` for test changes
   - `chore:` for build/maintenance

6. **Push to Your Fork**
   ```bash
   git push origin feature/your-feature-name
   ```

7. **Create a Pull Request**
   - Provide a clear title and description
   - Reference any related issues
   - Ensure CI/CD checks pass
   - Wait for code review

## Code Style Guidelines

### JavaScript

- Use 2-space indentation
- Use const/let instead of var
- Add semicolons at the end of statements
- Use camelCase for variables and functions
- Use PascalCase for classes and constructors

Example:
```javascript
// Good
const getUserData = (userId) => {
  const data = database.findUser(userId);
  return data;
};

// Bad
var getUserData=function(userId){
  var data=database.findUser(userId)
  return data
}
```

### Comments

- Write clear, concise comments
- Explain the "why", not the "what"
- Keep comments up-to-date with code changes

```javascript
// Good - explains purpose
// Retry logic for temporary network failures
let retries = 0;
while (retries < maxRetries && !success) {
  // ...
}

// Bad - obvious from code
// Increment retries
retries++;
```

### File Organization

- Group related functionality together
- Keep files focused and maintainable
- Use descriptive file names

## Development Setup

1. Clone and install dependencies (see README.md)
2. Configure `.env` file with test credentials
3. Start MongoDB locally or use test database
4. Run `npm run dev` for development

## Testing Requirements

- All new features must include tests
- All bug fixes should include tests that would have caught the bug
- Maintain or improve code coverage
- Run `npm test` before submitting PR

## Documentation

- Update README.md if changing functionality
- Add JSDoc comments for new functions
- Update API documentation if adding/changing endpoints
- Include examples for new features

## Pull Request Review Process

1. **Automated Checks**: All CI/CD checks must pass
2. **Code Review**: At least one maintainer review required
3. **Testing**: Reviewer may request additional tests
4. **Discussion**: Be open to feedback and suggestions
5. **Approval**: Once approved, your PR will be merged

## Areas for Contribution

### High Priority
- Documentation improvements
- Bug fixes
- Security enhancements
- Performance optimizations
- Test coverage expansion

### Medium Priority
- Feature enhancements
- Code refactoring
- UI/UX improvements
- Internationalization (i18n) support

### Lower Priority
- Minor optimizations
- Code style improvements
- Comment updates

## Questions & Support

- Open a GitHub Discussion for questions
- Check existing issues and documentation first
- Be respectful and patient

## Recognition

Contributors will be recognized in:
- Git commit history
- Project README (with permission)
- Release notes for significant contributions

## Commit Message Guidelines

Follow the conventional commits format:

```
<type>(<scope>): <subject>

<body>

<footer>
```

Examples:
- `feat(api): Add new user endpoint`
- `fix(bot): Handle telegram message timeout`
- `docs(readme): Update installation instructions`
- `test(referral): Add referral calculation tests`

## Version Numbering

This project uses semantic versioning (MAJOR.MINOR.PATCH):
- MAJOR: Breaking changes
- MINOR: New features (backward compatible)
- PATCH: Bug fixes

## Security Issues

Do not open a public issue for security vulnerabilities. Please see [SECURITY.md](SECURITY.md) for responsible disclosure procedures.

---

Thank you for contributing to StarStore! Your efforts help make this project better for everyone.

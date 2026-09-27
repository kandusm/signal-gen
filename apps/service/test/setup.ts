import { Logger } from '@nestjs/common';

// The services under test log deliberately and at volume. That is useful in
// production and noise in a test run, where a failure should be the only
// thing on screen.
Logger.overrideLogger(false);

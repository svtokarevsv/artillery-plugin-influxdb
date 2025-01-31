'use strict';

var Influx = require('influx'),
    uuid = require('uuid'),
    util = require('util'),
    constants = {
        PLUGIN_NAME: 'influxdb',

        // indexes of artillery's results:
        TIMESTAMP: 0,
        REQUEST_ID: 1,
        LATENCY: 2,
        STATUS_CODE: 3,

        // required configuration names
        CONFIG_TEST_NAME: 'testName',
        CONFIG_MEASUREMENT_NAME: 'measurementName',
        CONFIG_ERROR_MEASUREMENT_NAME: 'errorMeasurementName',
        CONFIG_TEST_RUN_ID: 'testRunId',
        CONFIG_EXCLUDE_TEST_RUN_ID: 'excludeTestRunId',
        CONFIG_INFLUX: 'influx',
        CONFIG_INFLUX_HOST: 'host',
        CONFIG_INFLUX_USERNAME: 'username',
        CONFIG_INFLUX_PASSWORD: 'password',
        CONFIG_INFLUX_DATABASE: 'database',
        CONFIG_STATIC_TAGS: 'tags',
        CONFIG_SHOW_MATCHES: 'show',

        // Defaults
        DEFAULT_MEASUREMENT_NAME: 'latency',
        DEFAULT_ERROR_MEASUREMENT_NAME: 'clientErrors',

        // environment variables
        ENV_INFLUX_USERNAME: 'INFLUX_USERNAME',
        ENV_INFLUX_PASSWORD: 'INFLUX_PASSWORD',
        ENV_INFLUX_HOST: 'INFLUX_HOST',
        ENV_INFLUX_DB: 'INFLUX_DB'
    },
    messages = {
        pluginsConfigNotFound: 'No "plugins" configuration found.',
        pluginConfigIsRequired: 'The configuration for %s is required.',
        pluginParamIsRequired: 'The configuration parameter %s is required.',
        pluginParamOrEnvIsRequired: 'The configuration parameter %s or environment variable %s is required.',
        influxdbHostMustBeHostname: 'The %s property must be a host name only, protocol and port cannot be used.',
        metricsReportedToInflux: '%s metrics reported to InfluxDB.'
    },
    impl = {
        handleError: function(message) {
            console.error(message);
            throw new Error(message);
        },
        determineInfluxLoginCredentials: function(pluginConfig) {
            function setFromConfigOrEnv(configName, envName) {
                // Check to see if value is provided in config
                if (!pluginConfig[constants.CONFIG_INFLUX][configName]) {
                    // If not, try to read it from the environment.
                    if (process.env[envName]) {
                        pluginConfig[constants.CONFIG_INFLUX][configName] = process.env[envName];
                    } else {
                        // Cannot proceed without this value
                        impl.handleError(util.format(messages.pluginParamOrEnvIsRequired, constants.CONFIG_INFLUX + '.' + configName, envName));
                    }
                }
            }

            setFromConfigOrEnv(constants.CONFIG_INFLUX_USERNAME, constants.ENV_INFLUX_USERNAME);
            setFromConfigOrEnv(constants.CONFIG_INFLUX_PASSWORD, constants.ENV_INFLUX_PASSWORD);
            setFromConfigOrEnv(constants.CONFIG_INFLUX_HOST, constants.ENV_INFLUX_HOST);
            setFromConfigOrEnv(constants.CONFIG_INFLUX_DATABASE, constants.ENV_INFLUX_DB);
        },
        validateConfig: function (scriptConfig) {
            // These are the minimum required config values
            var requiredInfluxConfigs = [
                constants.CONFIG_INFLUX_HOST,
                constants.CONFIG_INFLUX_USERNAME,
                constants.CONFIG_INFLUX_PASSWORD,
                constants.CONFIG_INFLUX_DATABASE
            ];

            // There must be a configuration object.
            if (!scriptConfig) {
                impl.handleError(util.format(messages.pluginConfigIsRequired, constants.PLUGIN_NAME));
            }

            // Create a set of static tags if none already
            if (!scriptConfig[constants.CONFIG_STATIC_TAGS]) {
                scriptConfig[constants.CONFIG_STATIC_TAGS] = {};
            }

            impl.determineInfluxLoginCredentials(scriptConfig);

            // It must provide a test name; alternate version accepted.
            if (!scriptConfig[constants.CONFIG_TEST_NAME]) {
                impl.handleError(util.format(messages.pluginParamIsRequired, constants.CONFIG_TEST_NAME));
            }

            // Add the test name to the set of tags to be written
            scriptConfig[constants.CONFIG_STATIC_TAGS][constants.CONFIG_TEST_NAME] = scriptConfig[constants.CONFIG_TEST_NAME];

            // Use measurement names provided in the config, otherwise use the default ones.
            if (!scriptConfig[constants.CONFIG_MEASUREMENT_NAME]) {
                scriptConfig[constants.CONFIG_MEASUREMENT_NAME] = constants.DEFAULT_MEASUREMENT_NAME;
            }

            if (!scriptConfig[constants.CONFIG_ERROR_MEASUREMENT_NAME]) {
                scriptConfig[constants.CONFIG_ERROR_MEASUREMENT_NAME] = constants.DEFAULT_ERROR_MEASUREMENT_NAME;
            }

            // If no testRunId is provided in the static tags, and excludeTestRunId is not set then generate one.
            if (!scriptConfig[constants.CONFIG_STATIC_TAGS][constants.CONFIG_TEST_RUN_ID] &&
                !scriptConfig[constants.CONFIG_EXCLUDE_TEST_RUN_ID]) {
                scriptConfig[constants.CONFIG_STATIC_TAGS][constants.CONFIG_TEST_RUN_ID] = uuid.v4();
            }

            // Check each of the influx-specific settings and validate.
            requiredInfluxConfigs.forEach(function(configName) {
                    if (!scriptConfig[constants.CONFIG_INFLUX][configName]) {
                        impl.handleError(util.format(messages.pluginParamIsRequired, constants.CONFIG_INFLUX + '.' + configName));
                    }

                    // Check that host is name only: no protocol or port.
                    if (configName === constants.CONFIG_INFLUX_HOST) {
                        var host = scriptConfig[constants.CONFIG_INFLUX][configName];
                        if (host.indexOf(':') > -1 || host.indexOf('/') > -1) {
                            impl.handleError(util.format(messages.influxdbHostMustBeHostname, constants.CONFIG_INFLUX + '.' + configName));
                        }
                    }
                }
            );

            return scriptConfig;
        },
        createReporter: function (config) {
            return new Influx(config.influx);
        },
        reportResults: function (instance, influxReporter, testReport) {
            var points = [],
                samples = 0,
                sample;

            // Work around change in testReport schema in artillery-core (Issue #3)
            if (testReport._entries) {
                testReport.latencies = testReport._entries;
            }

            // For each of the latencies, create a point for influx,
            // adding any static tags from the config.
            while (samples < testReport.latencies.length) {
                sample = testReport.latencies[samples++];
                // to avoid undefined error, check if matches is included and if not set to empty string so it fails next if
                if (!instance.config[constants.CONFIG_INFLUX].matches) {
                    instance.config[constants.CONFIG_INFLUX].matches = '';
                }
                // if matches specified in script, send match data to influxdb, else keep everything as it was
                if (JSON.parse(JSON.stringify(instance.config[constants.CONFIG_INFLUX].matches)) === constants.CONFIG_SHOW_MATCHES) {
                    points.push([{
                        matches: testReport._matches,
                        time: sample[constants.TIMESTAMP],
                        value: sample[constants.LATENCY] / 1000000
                    }, Object.assign({
                        request_id: sample[constants.REQUEST_ID],
                        response: sample[constants.STATUS_CODE]
                    }, instance.config[constants.CONFIG_STATIC_TAGS])]);
                } else {
                    points.push([{
                        time: sample[constants.TIMESTAMP],
                        value: sample[constants.LATENCY] / 1000000
                    }, Object.assign({
                        request_id: sample[constants.REQUEST_ID],
                        response: sample[constants.STATUS_CODE]
                    }, instance.config[constants.CONFIG_STATIC_TAGS])]);
                }
            }
            if (!points.length) {
                return;
            }
            influxReporter.writePoints(instance.config[constants.CONFIG_MEASUREMENT_NAME], points, function (err) {
                if (err) {
                    impl.handleError(err.message);
                } else {
                    console.log(util.format(messages.metricsReportedToInflux, points.length));
                }
            });
        },
        reportErrors: function (instance, influxReporter, testReport) {
            var errorCount = 0,
                points = [];

            // Work around change in testReport schema in artillery-core (Issue #3)
            if (testReport._errors) {
                testReport.errors = testReport._errors;
            }

            // If there are no errors or error measurement name not defined (or empty), then exit.
            if (!testReport.errors || !Object.keys(testReport.errors).length || !instance.config[constants.CONFIG_STATIC_TAGS]) {
                return;
            }

            // For each of the error types reported, create a point for influx.
            Object.getOwnPropertyNames(testReport.errors).forEach(function(propertyName) {
                errorCount += testReport.errors[propertyName];
            });

            // Add the single metric to the reported data points.
            points.push([{
                time: Date.now(),
                value: errorCount
            }, Object.assign({}, instance.config[constants.CONFIG_STATIC_TAGS])]);

            // If errors were found, log them.
            if (points.length > 0) {
                influxReporter.writePoints(instance.config[constants.CONFIG_ERROR_MEASUREMENT_NAME], points, function (err) {
                    if (err) {
                        impl.handleError(err.message);
                    } else {
                        console.log(util.format(messages.metricsReportedToInflux, points.length));
                    }
                });
            }
        }
    },
    api = {
        init: function (scriptConfig, eventEmitter) {
            var reporter,
                that;

            that = this;

            // Check for presence of any Plugin configuration.
            if (!scriptConfig || !scriptConfig.plugins) {
                impl.handleError(constants.pluginsConfigNotFound);
            }

            // Validate the settings provided for our specific Plugin.
            this.config = impl.validateConfig(scriptConfig.plugins[constants.PLUGIN_NAME]);

            // Create a reporting client and attach to DONE event from Artillery.
            reporter = impl.createReporter(this.config);
            eventEmitter.on('stats', function (report) {
                // Got some results! Report results to influx.
                impl.reportResults(that, reporter, report);
                impl.reportErrors(that, reporter, report);
            });
        }
    };

module.exports = api.init;

/* test-code */
module.exports.constants = constants;
module.exports.messages = messages;
module.exports.impl = impl;
module.exports.api = api;
/* end-test-code */

import { getColor } from '../../../config/bot.js';
import {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ChannelSelectMenuBuilder,
    RoleSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    MessageFlags,
    ComponentType,
    EmbedBuilder,
    LabelBuilder,
    CheckboxBuilder,
    TextDisplayBuilder,
} from 'discord.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { successEmbed, errorEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { TitanBotError, ErrorTypes } from '../../../utils/errorHandler.js';
import { safeDeferInteraction } from '../../../utils/interactionValidator.js';
import {
    getApplicationSettings,
    saveApplicationSettings,
    getApplicationRoles,
    saveApplicationRoles,
    getApplicationRoleSettings,
    saveApplicationRoleSettings,
    deleteApplicationRoleSettings,
    getApplications,
    deleteApplication,
} from '../../../utils/database.js';

// ─── Embed & Menu Builders ────────────────────────────────────────────────────

function buildDashboardEmbed(settings, roles, guild) {
    const logChannel = settings.logChannelId ? `<#${settings.logChannelId}>` : '`Not set`';
    const managerRoleList =
        settings.managerRoles?.length > 0
            ? settings.managerRoles.map(id => `<@&${id}>`).join(', ')
            : '`Nici o configurare`';
    const roleList =
        roles.length > 0
            ? roles.map(r => `<@&${r.roleId}> — ${r.name}`).join('\n')
            : '`Nu este configurat nici un rol`';
    const questionCount = settings.questions?.length ?? 0;
    const firstQ =
        settings.questions?.[0]
            ? `\`${settings.questions[0].length > 55 ? settings.questions[0].substring(0, 55) + '…' : settings.questions[0]}\``
            : '`Not set`';

    return new EmbedBuilder()
        .setTitle('📋 Aplicatii dashboard')
        .setDescription(`Schimba setarile aplicatiilor pentru **${guild.name}**.\nSelecteaza o optiune de mai jos pentru a modifica o setare.`)
        .setColor(getColor('info'))
        .addFields(
            { name: '⚙️ Application Status', value: settings.enabled ? '✅ Activat' : '❌ Dezactivat', inline: true },
            { name: '📢 Log Channel', value: logChannel, inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
            { name: '🛡️ Manager Roles', value: managerRoleList, inline: false },
            { name: '📝 Questions', value: `${questionCount} configured — first: ${firstQ}`, inline: false },
            { name: '🎭 Application Roles', value: roleList, inline: false },
            {
                name: '🗑️ Retention',
                value: `Pending: **${settings.pendingApplicationRetentionDays ?? 30}d** · Reviewed: **${settings.reviewedApplicationRetentionDays ?? 14}d**`,
                inline: false,
            },
        )
        .setFooter({ text: 'Dashboard-ul se va inchide automat dupa 15 minute de inactivitate' })
        .setTimestamp();
}

function buildSelectMenu(guildId) {
    return new StringSelectMenuBuilder()
        .setCustomId(`app_cfg_${guildId}`)
        .setPlaceholder('Selecteaza o setare pentru a o configura...')
        .addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel('Log Channel')
                .setDescription('Seteaza canalul in care vor aparea log-urile aplicatiilor')
                .setValue('log_channel')
                .setEmoji('📢'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Manager Roles')
                .setDescription('Adauga sau elimina un rol care sa gestioneze aplicatiile')
                .setValue('manager_role')
                .setEmoji('🛡️'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Edit Questions')
                .setDescription('Personalizeaza-ti intrebarile pentru formuralul aplicatiei')
                .setValue('questions')
                .setEmoji('📝'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Add Application Role')
                .setDescription('Adauga un rol care poate aplica')
                .setValue('role_add')
                .setEmoji('➕'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Remove Application Role')
                .setDescription('Elimina un rol care poate aplica')
                .setValue('role_remove')
                .setEmoji('➖'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Retention Period')
                .setDescription('Setati durata de pastrare a aplicatiilor în asteptare si a celor revizuite')
                .setValue('retention')
                .setEmoji('🗑️'),
        );
}

function buildButtonRow(settings, guildId, disabled = false) {
    const systemOn = settings.enabled === true;
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`app_cfg_toggle_${guildId}`)
            .setLabel('Applications')
            .setStyle(systemOn ? ButtonStyle.Success : ButtonStyle.Danger)
            .setDisabled(disabled),
    );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function refreshDashboard(rootInteraction, settings, roles, guildId) {
    const selectMenu = buildSelectMenu(guildId);
    await InteractionHelper.safeEditReply(rootInteraction, {
        embeds: [buildDashboardEmbed(settings, roles, rootInteraction.guild)],
        components: [
            buildButtonRow(settings, guildId),
            new ActionRowBuilder().addComponents(selectMenu),
        ],
    }).catch(() => {});
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export default {
    async execute(interaction, config, client, selectedAppName = null) {
        try {
            const guildId = interaction.guild.id;

            // Defer immediately to prevent Discord interaction timeout
            await InteractionHelper.safeDefer(interaction, { flags: ['Ephemeral'] });

            const [settings, roles] = await Promise.all([
                getApplicationSettings(client, guildId),
                getApplicationRoles(client, guildId),
            ]);

            // Check if application system is completely unconfigured
            const isCompletelyUnconfigured = 
                !settings.logChannelId && 
                !settings.enabled && 
                (settings.managerRoles?.length ?? 0) === 0 && 
                roles.length === 0;

            if (isCompletelyUnconfigured) {
                throw new TitanBotError(
                    'Systemul aplicatiei nu este setat',
                    ErrorTypes.CONFIGURATION,
                    'Systemul aplicatiilor nu a fost inca setat. Te rugam sa folosesti comanda /app-admin setup pentru crearea unei aplicatii',
                );
            }

            // If no application roles exist, show global settings to add one
            if (roles.length === 0) {
                await showGlobalDashboard(interaction, settings, roles, guildId, client);
                return;
            }

            // If a specific app was selected via autocomplete, show its dashboard directly
            if (selectedAppName) {
                const selectedRole = roles.find(r => r.name.toLowerCase() === selectedAppName.toLowerCase());
                if (selectedRole) {
                    await showApplicationDashboard(interaction, selectedRole, settings, roles, guildId, client);
                    return;
                }
                // If name doesn't match, fall through
            }

            // Default: Show first application if no selection made
            const defaultRole = roles[0];
            await showApplicationDashboard(interaction, defaultRole, settings, roles, guildId, client);

        } catch (error) {
            if (error instanceof TitanBotError) throw error;
            logger.error('Unexpected error in app_dashboard:', error);
            throw new TitanBotError(
               `Aplicatia dashboard a esuat: ${error.message}`,
                ErrorTypes.UNKNOWN,
                'Esuat la deschiderea aplicatiilor din dashboard.',
            );
        }
    },
};

// ─── Application Selector (for multiple applications) ──────────────────────────

async function showApplicationSelector(interaction, roles, settings, guildId, client) {
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`app_select_${guildId}`)
        .setPlaceholder('Selecteaza o aplicatie pentru configuratie...')
        .addOptions(
            roles.map(role =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(role.name)
                    .setDescription(`Co ${role.name} application`)
                    .setValue(role.roleId)
                    .setEmoji('📋'),
            ),
        );

    const embed = new EmbedBuilder()
        .setTitle('🎯 Selecteaza aplicatia')
        .setDescription('Seteaza ce rol vrei sa configurezi.')
        .setColor(getColor('info'));

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(selectMenu)],
    });

    const collector = interaction.channel.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: i =>
            i.user.id === interaction.user.id && i.customId === `app_select_${guildId}`,
        time: 600_000,
        max: 1,
    });

    collector.on('collect', async selectInteraction => {
        const deferred = await safeDeferInteraction(selectInteraction);
        if (!deferred) return;
        
        const selectedRoleId = selectInteraction.values[0];
        const selectedRole = roles.find(r => r.roleId === selectedRoleId);

        if (selectedRole) {
            await showApplicationDashboard(interaction, selectedRole, settings, roles, guildId, client);
        }
    });

    collector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            InteractionHelper.safeEditReply(interaction, {
                embeds: [errorEmbed('Fara timp', 'Nu a fost selectat nimic. Dashboard-ul se va inchide.')],
                components: [],
            }).catch(() => {});
        }
    });
}

// ─── Global Dashboard ──────────────────────────────────────────────────────────

async function showGlobalDashboard(interaction, settings, roles, guildId, client) {
    const selectMenu = buildSelectMenu(guildId);

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [buildDashboardEmbed(settings, roles, interaction.guild)],
        components: [
            buildButtonRow(settings, guildId),
            new ActionRowBuilder().addComponents(selectMenu),
        ],
    });

    setupCollectors(interaction, settings, roles, guildId, client, null);
}

// ─── Application-Specific Dashboard ────────────────────────────────────────────

async function showApplicationDashboard(rootInteraction, selectedRole, settings, roles, guildId, client) {
    const roleObj = rootInteraction.guild.roles.cache.get(selectedRole.roleId);
    
    // Get application-specific settings
    const appSettings = await getApplicationRoleSettings(client, guildId, selectedRole.roleId);
    const questions = appSettings.questions || settings.questions || [];
    const appLogChannelId = appSettings.logChannelId || settings.logChannelId;
    const isEnabled = selectedRole.enabled !== false; // Default to true if not specified

    // Build comprehensive embed
    const logChannelDisplay = appLogChannelId 
        ? `<#${appLogChannelId}>` 
        : '`Inherits global log channel`';
    
    const questionsDisplay = questions.length > 0
        ? questions.map((q, i) => `${i + 1}. \`${q.length > 60 ? q.substring(0, 60) + '…' : q}\``).join('\n')
        : '`Inherits global questions`';
    
    const managerRolesDisplay = settings.managerRoles && settings.managerRoles.length > 0
        ? settings.managerRoles.map(id => `<@&${id}>`).join(', ')
        : '`None configured`';

    const embed = new EmbedBuilder()
        .setTitle('🎭 Aplicatii dashboard')
        .setDescription(`Configuration for **${selectedRole.name}**`)
        .setColor(isEnabled ? getColor('success') : getColor('error'))
        .addFields(
            { 
                name: '🎭 rol-uri', 
                value: roleObj ? roleObj.toString() : `<@&${selectedRole.roleId}>`, 
                inline: true 
            },
            { 
                name: '⚙️ Statusul aplicatiei', 
                value: isEnabled ? '✅ **Activat**' : '❌ **Dezactivat**', 
                inline: true 
            },
            { name: '\u200B', value: '\u200B', inline: true },
            { 
                name: '📝 intrebari', 
                value: questionsDisplay,
                inline: false 
            },
            { 
                name: '📢 canal de log-uri', 
                value: logChannelDisplay,
                inline: true 
            },
            { 
                name: '🛡️ gestioneaza rolurile',
                value: managerRolesDisplay,
                inline: true 
            },
            { 
                name: '🗑️ Perioada de pastrare',
                value: `Pending: **${settings.pendingApplicationRetentionDays ?? 30}d** · Reviewed: **${settings.reviewedApplicationRetentionDays ?? 14}d**`,
                inline: false 
            },
        )
        .setFooter({ text: 'Dashboard-ul se va inchide dupa 10 minute de inactivitate' })
        .setTimestamp();

    // Create dropdown button with customization options
    const configMenu = buildApplicationSelectMenu(guildId, selectedRole.roleId);

    // Create control buttons
    const controlButtons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`app_toggle_${selectedRole.roleId}`)
            .setLabel(isEnabled ? 'Disable Application' : 'Enable Application')
            .setStyle(isEnabled ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`app_delete_${selectedRole.roleId}`)
            .setLabel('Sterge aplicatia')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🗑️'),
    );

    const menuRow = new ActionRowBuilder().addComponents(configMenu);

    await InteractionHelper.safeEditReply(rootInteraction, {
        embeds: [embed],
        components: [menuRow, controlButtons],
    });

    setupCollectors(rootInteraction, settings, roles, guildId, client, selectedRole.roleId);
}

// ─── Collector Setup ──────────────────────────────────────────────────────────

function setupCollectors(interaction, settings, roles, guildId, client, selectedRoleId) {
    const customIdPrefix = selectedRoleId ? `app_cfg_${selectedRoleId}` : `app_cfg_${guildId}`;
    
    const collector = interaction.channel.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: i =>
            i.user.id === interaction.user.id && 
            (selectedRoleId 
                ? i.customId === customIdPrefix
                : (i.customId === `app_cfg_${guildId}` || i.customId === `app_select_${guildId}`)),
        time: 600_000,
    });

    collector.on('collect', async selectInteraction => {
        const selectedOption = selectInteraction.values[0];
        try {
            // Catch expired interactions
            if (!selectInteraction.isStringSelectMenu()) {
                return;
            }
            switch (selectedOption) {
                case 'log_channel':
                    await handleLogChannel(selectInteraction, interaction, settings, roles, guildId, client, selectedRoleId);
                    break;
                case 'manager_role':
                    await handleManagerRole(selectInteraction, interaction, settings, roles, guildId, client, selectedRoleId);
                    break;
                case 'questions':
                    await handleQuestions(selectInteraction, interaction, settings, roles, guildId, client, selectedRoleId);
                    break;
                case 'role_add':
                    await handleRoleAdd(selectInteraction, interaction, settings, roles, guildId, client);
                    break;
                case 'role_remove':
                    await handleRoleRemove(selectInteraction, interaction, settings, roles, guildId, client);
                    break;
                case 'retention':
                    await handleRetention(selectInteraction, interaction, settings, roles, guildId, client, selectedRoleId);
                    break;
            }
        } catch (error) {
            if (error instanceof TitanBotError) {
                logger.debug(`Eroare de validare a configuratiei aplicatiilor : ${error.message}`);
            } else {
                logger.error('O eroare neasteptata de la dashboard:', error);
            }

            const errorMessage =
                error instanceof TitanBotError
                    ? error.userMessage || 'A aparut o eroare la procesarea selectiei tale.'
                    : 'A aparut o eroare neasteptata la actualizarea configuratiei.';

            if (!selectInteraction.replied && !selectInteraction.deferred) {
                await safeDeferInteraction(selectInteraction);
            }

            await selectInteraction
                .followUp({
                    embeds: [errorEmbed('Configuration Error', errorMessage)],
                    flags: MessageFlags.Ephemeral,
                })
                .catch(() => {});
        }
    });

    collector.on('end', async (collected, reason) => {
        if (reason === 'time') {
            const timeoutEmbed = new EmbedBuilder()
                .setTitle('\u23f0 Dashboard Timed Out')
                .setDescription('Acest dashboard a fost inchis din cauza neactivitatii. Te rugam sa rulezi comanda din nou pentru a continua.')
                .setColor(getColor('error'));
                
            await InteractionHelper.safeEditReply(interaction, {
                embeds: [timeoutEmbed],
                components: [],
            }).catch(() => {});
        }
    });

    // ── Global Toggle Button Collector ──────────────────────────────────────────
    if (!selectedRoleId) {
        const globalToggleCollector = interaction.channel.createMessageComponentCollector({
            componentType: ComponentType.Button,
            filter: i =>
                i.user.id === interaction.user.id &&
                i.customId === `app_cfg_toggle_${guildId}`,
            time: 600_000,
        });

        globalToggleCollector.on('collect', async toggleInteraction => {
            const deferred = await safeDeferInteraction(toggleInteraction);
            if (!deferred) return;
            
            try {
                const wasEnabled = settings.enabled === true;
                settings.enabled = !wasEnabled;

                // Save the updated settings
                await saveApplicationSettings(interaction.client, guildId, settings);

                // Refresh dashboard to show new status
                const updatedSettings = await getApplicationSettings(interaction.client, guildId);
                const updatedRoles = await getApplicationRoles(interaction.client, guildId);
                await showGlobalDashboard(interaction, updatedSettings, updatedRoles, guildId, interaction.client);

                await toggleInteraction.followUp({
                    embeds: [successEmbed(
                        wasEnabled ? '🔴 Aplicatie Dezactivata' : '🟢 Aplicatie Activata',
                        `systemul de aplicatii este acum **${wasEnabled ? 'dezactivat' : 'activat'}**.\n\n${
                            wasEnabled 
                                ? 'Membrii nu pot mai pot aplica pentru roluri.' 
                                : 'Membrii pot sa inceapa sa aplice pentru roluri.'
                        }`,
                    )],
                    flags: MessageFlags.Ephemeral,
                });

            } catch (error) {
                logger.error('Error toggling global application status:', error);
                await toggleInteraction.followUp({
                    embeds: [errorEmbed('Error', 'A aparut o eroare la comutarea starii aplicatiei.')],
                    flags: MessageFlags.Ephemeral,
                });
            }
        });

        globalToggleCollector.on('end', async (collected, reason) => {
            if (reason === 'time') {
                const timeoutEmbed = new EmbedBuilder()
                    .setTitle('⏱️ Timeout de configurare')
                    .setDescription('Acest dashboard va fi inchis din cauza neactivitatii (10 minutes).\n\nPentru a continua va rugam sa rulati comanda din nou.')
                    .setColor(getColor('warning'));
                    
                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [timeoutEmbed],
                    components: [],
                }).catch(() => {});
            }
        });
    }

    // ── Delete Button Collector (for application-specific dashboard) ──────────────
    if (selectedRoleId) {
        const btnCollector = interaction.channel.createMessageComponentCollector({
            componentType: ComponentType.Button,
            filter: i =>
                i.user.id === interaction.user.id &&
                i.customId === `app_delete_${selectedRoleId}`,
            time: 600_000,
        });

        btnCollector.on('collect', async btnInteraction => {
            // Show confirmation modal
            const appRoleForDelete = roles.find(r => r.roleId === selectedRoleId);
            const appNameForDelete = appRoleForDelete?.name ?? 'Aceasta aplicatie';

            const confirmModal = new ModalBuilder()
                .setCustomId('app_delete_confirm')
                .setTitle('Confirma stergerea aplicatiei');

            const deleteWarningText = new TextDisplayBuilder()
                .setContent(`⚠️ Esti pe cale sa stergi permanent **${appNameForDelete}**. Toate aplicațiile și setările stocate pentru acest rol vor fi eliminate și nu pot fi recuperate.`);

            const deleteCheckbox = new CheckboxBuilder()
                .setCustomId('confirm_delete')
                .setDefault(true);

            const deleteCheckboxLabel = new LabelBuilder()
                .setLabel('I confirm — this cannot be undone')
                .setCheckboxComponent(deleteCheckbox);

            confirmModal
                .addTextDisplayComponents(deleteWarningText)
                .addLabelComponents(deleteCheckboxLabel);

            try {
                await btnInteraction.showModal(confirmModal);
            } catch (error) {
                logger.error('Error showing delete confirmation modal:', error);
                await btnInteraction.followUp({
                    embeds: [errorEmbed('Error', 'Nu s-a putut afisa fereastra de confirmare. Va rugam sa incercati din nou.')],
                    flags: MessageFlags.Ephemeral,
                }).catch(() => {});
                return;
            }

            try {
                const confirmSubmit = await btnInteraction.awaitModalSubmit({
                    time: 60_000,
                    filter: i =>
                        i.customId === 'app_delete_confirm' && i.user.id === btnInteraction.user.id,
                }).catch(() => null);

                if (!confirmSubmit) {
                    await btnInteraction.followUp({
                        embeds: [errorEmbed('Cancelled', 'Stergerea aplicatiei a fost anulata.')],
                        flags: MessageFlags.Ephemeral,
                    });
                    return;
                }

                const confirmed = confirmSubmit.fields.getCheckbox('confirm_delete');
                if (!confirmed) {
                    await confirmSubmit.reply({
                        embeds: [errorEmbed('Not Confirmed', 'Trebuie sa bifati caseta de selectare pentru confirmare pentru a sterge aplicatia.')],
                        flags: MessageFlags.Ephemeral,
                    });
                    return;
                }

                // Delete the application
                await handleDeleteApplication(confirmSubmit, selectedRoleId, guildId, roles, client);
                collector.stop();
                btnCollector.stop();

            } catch (error) {
                logger.error('Eroare la confirmarea stergerii aplicatiei:', error);
                await btnInteraction.followUp({
                    embeds: [errorEmbed('Error', 'A aparut o eroare la stergerea aplicatiei.')],
                    flags: MessageFlags.Ephemeral,
                });
            }
        });

        btnCollector.on('end', async (collected, reason) => {
            if (reason === 'time') {
                const timeoutEmbed = new EmbedBuilder()
                    .setTitle('⏱️ Timeout de configurare')
                    .setDescription('Aceasta sesiune a tabloului de bord a expirat din cauza inactivitatii. (10 minutes).\n\nPentru a continua configurarea aplicatiilor, va rugam sa executati din nou comanda.')
                    .setColor(getColor('warning'));
                    
                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [timeoutEmbed],
                    components: [],
                }).catch(() => {});
            }
        });

        // ── Toggle Enable/Disable Button Collector ──────────────────────────────
        const toggleCollector = interaction.channel.createMessageComponentCollector({
            componentType: ComponentType.Button,
            filter: i =>
                i.user.id === interaction.user.id &&
                i.customId === `app_toggle_${selectedRoleId}`,
            time: 900_000,
        });

        toggleCollector.on('collect', async toggleInteraction => {
            const deferred = await safeDeferInteraction(toggleInteraction);
            if (!deferred) return;
            
            try {
                // Find and toggle the role
                const roleIndex = roles.findIndex(r => r.roleId === selectedRoleId);
                if (roleIndex === -1) {
                    await toggleInteraction.followUp({
                        embeds: [errorEmbed('Not Found', 'rolul aplicatiei nu a fost gasit.')],
                        flags: MessageFlags.Ephemeral,
                    });
                    return;
                }

                const wasEnabled = roles[roleIndex].enabled !== false;
                roles[roleIndex].enabled = !wasEnabled;

                // Save the updated roles
                await saveApplicationRoles(interaction.client, guildId, roles);

                // Refresh dashboard to show new status
                const updatedRole = roles[roleIndex];
                const updatedSettings = await getApplicationSettings(interaction.client, guildId);
                await showApplicationDashboard(interaction, updatedRole, updatedSettings, roles, guildId, interaction.client);

                await toggleInteraction.followUp({
                    embeds: [successEmbed(
                        wasEnabled ? '🔴 aplicatie dezactivata' : '🟢 aplicatie activata',
                        `The **${updatedRole.name}** application is now **${wasEnabled ? 'disabled' : 'enabled'}**.\n\n${
                            wasEnabled 
                                ? 'Aceasta aplicatie nu va mai aparea în optiunile /apply submit.' 
                                : 'Aceasta aplicatie va aparea acum în optiunile /apply submit.'
                        }`,
                    )],
                    flags: MessageFlags.Ephemeral,
                });

            } catch (error) {
                logger.error('Eroare la comutarea starii aplicatiei:', error);
                await toggleInteraction.followUp({
                    embeds: [errorEmbed('Error', 'A aparut o eroare la comutarea starii aplicatiei.')],
                    flags: MessageFlags.Ephemeral,
                });
            }
        });

        toggleCollector.on('end', async (collected, reason) => {
            if (reason === 'time') {
                const timeoutEmbed = new EmbedBuilder()
                    .setTitle('⏱️ Timeout de configurare')
                    .setDescription('Acest dashboard va fi inchis din cauza neactivitatii (10 minutes).\n\nPentru a continua configurarea aplicatiilor, va rugam sa executati din nou comanda.')
                    .setColor(getColor('warning'));
                    
                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [timeoutEmbed],
                    components: [],
                }).catch(() => {});
            }
        });
    }
}

// ─── Build Select Menus ────────────────────────────────────────────────────────

function buildApplicationSelectMenu(guildId, roleId) {
    return new StringSelectMenuBuilder()
        .setCustomId(`app_cfg_${roleId}`)
        .setPlaceholder('Seleacteaza un rol de configurare...')
        .addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel('Log Channel')
                .setDescription('Seteaza canalul in care vor aparea log-urile aplicatiilor')
                .setValue('log_channel')
                .setEmoji('📢'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Manager Roles')
                .setDescription('Adauga sau elimina un rol care sa gestioneze aplicatiile')
                .setValue('manager_role')
                .setEmoji('🛡️'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Edit Questions')
                .setDescription('Personalizeaza-ti intrebarile pentru formuralul aplicatiei')
                .setValue('questions')
                .setEmoji('📝'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Retention Period')
                .setDescription('Setati durata de pastrare a aplicatiilor în asteptare si a celor revizuite')
                .setValue('retention')
                .setEmoji('🗑️'),
        );
}

// ─── Log Channel ──────────────────────────────────────────────────────────────

async function handleLogChannel(selectInteraction, rootInteraction, settings, roles, guildId, client, selectedRoleId) {
    let currentChannel = settings.logChannelId;
    if (selectedRoleId) {
        const roleSettings = await getApplicationRoleSettings(client, guildId, selectedRoleId);
        currentChannel = roleSettings.logChannelId || settings.logChannelId;
    }

    const modal = new ModalBuilder()
        .setCustomId(`app_cfg_log_channel_modal_${guildId}_${selectedRoleId || 'global'}`)
        .setTitle('📢 Configure Log Channel');

    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId('log_channel')
        .setPlaceholder('Selecteaza un canal...')
        .setMinValues(1)
        .setMaxValues(1)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true);

    const channelLabel = new LabelBuilder()
        .setLabel('Log Channel')
        .setDescription('Canalul unde vor fi înregistrate noile aplicatii')
        .setChannelSelectMenuComponent(channelSelect);

    modal.addLabelComponents(channelLabel);

    await selectInteraction.showModal(modal);

    try {
        const modalSubmission = await selectInteraction.awaitModalSubmit({
            time: 5 * 60 * 1000,
            filter: i => i.user.id === selectInteraction.user.id && i.customId === `app_cfg_log_channel_modal_${guildId}_${selectedRoleId || 'global'}`,
        });

        const channelId = modalSubmission.fields.getField('log_channel').values[0];
        const channel = selectInteraction.guild.channels.cache.get(channelId);

        if (selectedRoleId) {
            const roleSettings = await getApplicationRoleSettings(client, guildId, selectedRoleId);
            roleSettings.logChannelId = channelId;
            await saveApplicationRoleSettings(client, guildId, selectedRoleId, roleSettings);
        } else {
            settings.logChannelId = channelId;
            await saveApplicationSettings(client, guildId, settings);
        }

        await modalSubmission.reply({
            embeds: [successEmbed('✅ canalul de log-uri a fost acutualizat', `log-urile aplicației vor fi acum trimise către ${channel ?? `<#${channelId}>`}.`)],
            flags: MessageFlags.Ephemeral,
        });

        await refreshDashboard(rootInteraction, settings, roles, guildId);
    } catch (error) {
        if (error.code === 'INTERACTION_TIMEOUT') return;
        logger.error('Error in log channel modal:', error);
        await selectInteraction.followUp({
            embeds: [errorEmbed('A aparut o eroare la actualizarea canalului de log-uri.')],
            flags: MessageFlags.Ephemeral,
        });
    }
}

// ─── Manager Role ─────────────────────────────────────────────────────────────

async function handleManagerRole(selectInteraction, rootInteraction, settings, roles, guildId, client) {
    const modal = new ModalBuilder()
        .setCustomId(`app_cfg_manager_role_modal_${guildId}`)
        .setTitle('🛡️ Manager pentru configurarea rolurilor');

    const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId('manager_roles')
        .setPlaceholder('Selecteaza rolurile la care are acces managerul...')
        .setMinValues(1)
        .setMaxValues(5)
        .setRequired(true);

    const roleLabel = new LabelBuilder()
        .setLabel('Manager Roles')
        .setDescription('Rolurile selectate vor fi activate/dezactivate ca roluri de manager')
        .setRoleSelectMenuComponent(roleSelect);

    modal.addLabelComponents(roleLabel);

    await selectInteraction.showModal(modal);

    try {
        const modalSubmission = await selectInteraction.awaitModalSubmit({
            time: 5 * 60 * 1000,
            filter: i => i.user.id === selectInteraction.user.id && i.customId === `app_cfg_manager_role_modal_${guildId}`,
        });

        const selectedRoleIds = modalSubmission.fields.getField('manager_roles').values;
        const roleSet = new Set(settings.managerRoles ?? []);

        for (const roleId of selectedRoleIds) {
            if (roleSet.has(roleId)) {
                roleSet.delete(roleId);
            } else {
                roleSet.add(roleId);
            }
        }

        settings.managerRoles = Array.from(roleSet);
        await saveApplicationSettings(client, guildId, settings);

        const finalList = settings.managerRoles.length > 0
            ? settings.managerRoles.map(id => `<@&${id}>`).join(', ')
            : '`None`';

        await modalSubmission.reply({
            embeds: [successEmbed('✅ Manager Roles Updated', `Current manager roles: ${finalList}`)],
            flags: MessageFlags.Ephemeral,
        });

        await refreshDashboard(rootInteraction, settings, roles, guildId);
    } catch (error) {
        if (error.code === 'INTERACTION_TIMEOUT') return;
        logger.error('Error in manager role modal:', error);
        await selectInteraction.followUp({
            embeds: [errorEmbed('An error occurred while updating manager roles.')],
            flags: MessageFlags.Ephemeral,
        });
    }
}

// ─── Edit Questions ───────────────────────────────────────────────────────────

async function handleQuestions(selectInteraction, rootInteraction, settings, roles, guildId, client, selectedRoleId) {
    let currentQuestions = settings.questions ?? [];
    
    if (selectedRoleId) {
        const roleSettings = await getApplicationRoleSettings(client, guildId, selectedRoleId);
        currentQuestions = roleSettings.questions ?? currentQuestions;
    }

    const modal = new ModalBuilder()
        .setCustomId('app_cfg_questions')
        .setTitle('Edit Application Questions')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('q1')
                    .setLabel('Question 1 (required)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(currentQuestions[0] ?? '')
                    .setMaxLength(100)
                    .setMinLength(1)
                    .setRequired(true),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('q2')
                    .setLabel('Question 2 (required)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(currentQuestions[1] ?? '')
                    .setMaxLength(100)
                    .setRequired(false),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('q3')
                    .setLabel('Question 3 (optional)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(currentQuestions[2] ?? '')
                    .setMaxLength(100)
                    .setRequired(false),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('q4')
                    .setLabel('Question 4 (optional)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(currentQuestions[3] ?? '')
                    .setMaxLength(100)
                    .setRequired(false),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('q5')
                    .setLabel('Question 5 (optional)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(currentQuestions[4] ?? '')
                    .setMaxLength(100)
                    .setRequired(false),
            ),
        );

    await selectInteraction.showModal(modal);

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i =>
                i.customId === 'app_cfg_questions' && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    const newQuestions = ['q1', 'q2', 'q3', 'q4', 'q5']
        .map(key => submitted.fields.getTextInputValue(key).trim())
        .filter(Boolean);

    if (newQuestions.length === 0) {
        await submitted.reply({
            embeds: [errorEmbed('nici o intrevare', 'Este nevoie de cel putin o intrebare.')],
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    if (selectedRoleId) {
        // Save per-application questions
        const roleSettings = await getApplicationRoleSettings(client, guildId, selectedRoleId);
        roleSettings.questions = newQuestions;
        await saveApplicationRoleSettings(client, guildId, selectedRoleId, roleSettings);
    } else {
        // Save global questions
        settings.questions = newQuestions;
        await saveApplicationSettings(client, guildId, settings);
    }

    await submitted.reply({
        embeds: [
            successEmbed(
                '✅ Intrebarile au fost actualizate',
                `${newQuestions.length} question${newQuestions.length !== 1 ? 's' : ''} saved.`,
            ),
        ],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, settings, roles, guildId);
}

// ─── Add Application Role ─────────────────────────────────────────────────────

async function handleRoleAdd(selectInteraction, rootInteraction, settings, roles, guildId, client) {
    const modal = new ModalBuilder()
        .setCustomId(`app_cfg_role_add_modal_${guildId}`)
        .setTitle('➕ Adauga rol de aplicare');

    const roleSelect = new RoleSelectMenuBuilder()a
        .setCustomId('application_role')
        .setPlaceholder('Selecteaza rolurile care pot aplica...')
        .setMinValues(1)
        .setMaxValues(1)
        .setRequired(true);

    const roleLabel = new LabelBuilder()
        .setLabel('Aplicarea rolului')
        .setDescription('Selecteaza rolul care vrei sa aplici')
        .setRoleSelectMenuComponent(roleSelect);

    const nameInput = new TextInputBuilder()
        .setCustomId('role_name')
        .setLabel('Display name (leave blank to use role name)')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(50)
        .setRequired(false);

    modal.addLabelComponents(roleLabel);
    modal.addComponents(new ActionRowBuilder().addComponents(nameInput));

    await selectInteraction.showModal(modal);

    try {
        const modalSubmission = await selectInteraction.awaitModalSubmit({
            time: 5 * 60 * 1000,
            filter: i => i.user.id === selectInteraction.user.id && i.customId === `app_cfg_role_add_modal_${guildId}`,
        });

        const roleId = modalSubmission.fields.getField('application_role').values[0];
        const role = selectInteraction.guild.roles.cache.get(roleId);
        const customName = modalSubmission.fields.getTextInputValue('role_name').trim() || role?.name || roleId;

        if (roles.some(r => r.roleId === roleId)) {
            await modalSubmission.reply({
                embeds: [errorEmbed('Deja adaugat', `${role ?? roleId} este deja un rol pentru aplicatie.`)],
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        roles.push({ roleId, name: customName });
        await saveApplicationRoles(client, guildId, roles);

        await modalSubmission.reply({
            embeds: [successEmbed('✅ rol adaugat', `${role ?? roleId} a fost adaugat ca **${customName}**.`)],
            flags: MessageFlags.Ephemeral,
        });

        await refreshDashboard(rootInteraction, settings, roles, guildId);
    } catch (error) {
        if (error.code === 'INTERACTION_TIMEOUT') return;
        logger.error('Error in role add modal:', error);
        await selectInteraction.followUp({
            embeds: [errorEmbed('A aparut o eroare in timpul adaugarii rolului.')],
            flags: MessageFlags.Ephemeral,
        });
    }
}

// ─── Remove Application Role ──────────────────────────────────────────────────

async function handleRoleRemove(selectInteraction, rootInteraction, settings, roles, guildId, client) {
    if (roles.length === 0) {
        await selectInteraction.followUp({
            embeds: [errorEmbed('nici un rol', 'Nu exista roluri în aplicatie configurate pentru eliminare.')],
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const modal = new ModalBuilder()
        .setCustomId(`app_cfg_role_remove_modal_${guildId}`)
        .setTitle('➖ Elimina rolul aplicatiei');

    const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId('remove_role')
        .setPlaceholder('Selecteaza rolul pe care vrei sa il elimini...')
        .setMinValues(1)
        .setMaxValues(1)
        .setRequired(true);

    const roleLabel = new LabelBuilder()
        .setLabel('elimina rolul aplicatiei')
        .setDescription('selecteaza rolul de eliminat din lista de aplicatii')
        .setRoleSelectMenuComponent(roleSelect);

    modal.addLabelComponents(roleLabel);

    await selectInteraction.showModal(modal);

    try {
        const modalSubmission = await selectInteraction.awaitModalSubmit({
            time: 5 * 60 * 1000,
            filter: i => i.user.id === selectInteraction.user.id && i.customId === `app_cfg_role_remove_modal_${guildId}`,
        });

        const roleId = modalSubmission.fields.getField('remove_role').values[0];
        const index = roles.findIndex(r => r.roleId === roleId);

        if (index === -1) {
            await modalSubmission.reply({
                embeds: [errorEmbed('negasit', `<@&${roleId}> nu se afla in lista de roluri din aplicatie.`)],
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        roles.splice(index, 1);
        await saveApplicationRoles(client, guildId, roles);

        await modalSubmission.reply({
            embeds: [successEmbed('✅ rol eliminat', `<@&${roleId}> a fost eliminat din rolurile aplicatiei.`)],
            flags: MessageFlags.Ephemeral,
        });

        await refreshDashboard(rootInteraction, settings, roles, guildId);
    } catch (error) {
        if (error.code === 'INTERACTION_TIMEOUT') return;
        logger.error('Error in role remove modal:', error);
        await selectInteraction.followUp({
            embeds: [errorEmbed('A aparut o eroare la eliminarea rolului din aplicatie.')],
            flags: MessageFlags.Ephemeral,
        });
    }
}

// ─── Retention Period ─────────────────────────────────────────────────────────

async function handleRetention(selectInteraction, rootInteraction, settings, roles, guildId, client) {
    const modal = new ModalBuilder()
        .setCustomId('app_cfg_retention')
        .setTitle('Perioadele de pastrare a aplicatiilor');

    const retentionInfo = new TextDisplayBuilder()
        .setContent(
            '**In asteptare** — cat timp sunt pastrate aplicatiile fara raspuns/în curs de procesare înainte de a fi eliminate automat.\n' +
            '**Revizuit** — cat timp sunt pastrate cererile aprobate sau respinse.\n' +
            '-# Introduceti un numar intreg intre 1 și 3650 (max 10 ani).',
        );

    const pendingLabel = new LabelBuilder()
        .setLabel('in asteptarea retinerii (days)')
        .setTextInputComponent(
            new TextInputBuilder()
                .setCustomId('pending_days')
                .setStyle(TextInputStyle.Short)
                .setValue(String(settings.pendingApplicationRetentionDays ?? 30))
                .setMaxLength(4)
                .setMinLength(1)
                .setRequired(true),
        );

    const reviewedLabel = new LabelBuilder()
        .setLabel('Retentie revizuită (days)')
        .setTextInputComponent(
            new TextInputBuilder()
                .setCustomId('reviewed_days')
                .setStyle(TextInputStyle.Short)
                .setValue(String(settings.reviewedApplicationRetentionDays ?? 14))
                .setMaxLength(4)
                .setMinLength(1)
                .setRequired(true),
        );

    modal
        .addTextDisplayComponents(retentionInfo)
        .addLabelComponents(pendingLabel, reviewedLabel);

    await selectInteraction.showModal(modal);

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i =>
                i.customId === 'app_cfg_retention' && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;

    const pendingDays = parseInt(submitted.fields.getTextInputValue('pending_days').trim(), 10);
    const reviewedDays = parseInt(submitted.fields.getTextInputValue('reviewed_days').trim(), 10);

    if (isNaN(pendingDays) || pendingDays < 1 || pendingDays > 3650) {
        await submitted.reply({
            embeds: [errorEmbed('Valoare nevalida', 'Retinerea în asteptare trebuie să fie un numar întreg între **1** și **3650** zile.')],
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    if (isNaN(reviewedDays) || reviewedDays < 1 || reviewedDays > 3650) {
        await submitted.reply({
            embeds: [errorEmbed('Valoare nevalida', 'Retinerea în asteptare trebuie să fie un numar întreg între **1** și **3650** zile.')],
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    settings.pendingApplicationRetentionDays = pendingDays;
    settings.reviewedApplicationRetentionDays = reviewedDays;
    await saveApplicationSettings(client, guildId, settings);

    await submitted.reply({
        embeds: [
            successEmbed(
                '✅ Retinerea a fost actualizata',
                `Cererile in asteptare vor fi păstrate pentru **${pendingDays} days**.\nCererile evaluate vor fi păstrate pentru **${reviewedDays} zile**.`,
            ),
        ],
        flags: MessageFlags.Ephemeral,
    });

    await refreshDashboard(rootInteraction, settings, roles, guildId);
}

// ─── Delete Application ───────────────────────────────────────────────────────

async function handleDeleteApplication(confirmSubmit, selectedRoleId, guildId, roles, client) {
    try {
        // Find the application in the roles array
        const roleIndex = roles.findIndex(r => r.roleId === selectedRoleId);
        if (roleIndex === -1) {
            await confirmSubmit.reply({
                embeds: [errorEmbed('negasit', 'Rolul aplicatiei nu a fost gasit.')],
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const deletedRole = roles[roleIndex];

        // Remove from roles array
        roles.splice(roleIndex, 1);

        // Save updated roles list
        await saveApplicationRoles(client, guildId, roles);

        // Delete per-application settings
        await deleteApplicationRoleSettings(client, guildId, selectedRoleId);

        // Get all applications for this guild and find ones with this roleId
        const allApplications = await getApplications(client, guildId);
        const applicationsToDelete = allApplications.filter(app => app.roleId === selectedRoleId);

        // Delete each application
        for (const app of applicationsToDelete) {
            await deleteApplication(client, guildId, app.id, app.userId);
        }

        // Send success message
        await confirmSubmit.reply({
            embeds: [
                successEmbed(
                    '🗑️ Aplicatie stearsa',
                    `Aplicatia pentru <@&${selectedRoleId}> (**${deletedRole.name}**) a fost permanent stearsa.\n\n` +
                    `Stearsa: **${applicationsToDelete.length}** Aplicatia${applicationsToDelete.length !== 1 ? 's' : ''}`,
                ),
            ],
            flags: MessageFlags.Ephemeral,
        });

    } catch (error) {
        logger.error('Eroare in handleDeleteApplication:', error);
        await confirmSubmit.reply({
            embeds: [errorEmbed('Eroare', 'A aparut o eroare la stergerea aplicatiei. Va rugam să incercati din nou.')],
            flags: MessageFlags.Ephemeral,
        });
    }
}

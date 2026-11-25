package com.linkok.app.core

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/**
 * 手机端配置。
 *
 * 术语见 CONTEXT.md：Token / Pairing / Retention / Stash。
 * 字段与 docs/PROTOCOL.md §7 的 PC 配置保持平行，但两端各自独立存取。
 */
data class PhoneConfig(
    /** 配对后由 Hub 签发，长期有效。为空表示尚未配对。 */
    val token: String = "",
    /** 上次已知的 Hub 地址，形如 192.168.1.100:8787。 */
    val hubAddress: String = "",
    /** Hub 指纹，用于 UDP 重发现时确认是同一个 Hub。 */
    val hubFingerprint: String = "",
    /** 保留期天数：7 / 15 / 30 / 0（0 = 永不）。 */
    val retentionDays: Int = 30,
    /** 前台服务是否已启用（用户可在设置里关掉）。 */
    val serviceEnabled: Boolean = true,
    /** 配对时记录，用于设置页展示。 */
    val pairedAt: String = "",
)

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "linkok_config")

class ConfigStore(private val context: Context) {

    private object Keys {
        val TOKEN = stringPreferencesKey("token")
        val HUB_ADDRESS = stringPreferencesKey("hub_address")
        val HUB_FINGERPRINT = stringPreferencesKey("hub_fingerprint")
        val RETENTION_DAYS = intPreferencesKey("retention_days")
        val SERVICE_ENABLED = booleanPreferencesKey("service_enabled")
        val PAIRED_AT = stringPreferencesKey("paired_at")
    }

    val config: Flow<PhoneConfig> = context.dataStore.data.map { prefs ->
        PhoneConfig(
            token = prefs[Keys.TOKEN] ?: "",
            hubAddress = prefs[Keys.HUB_ADDRESS] ?: "",
            hubFingerprint = prefs[Keys.HUB_FINGERPRINT] ?: "",
            retentionDays = prefs[Keys.RETENTION_DAYS] ?: 30,
            serviceEnabled = prefs[Keys.SERVICE_ENABLED] ?: true,
            pairedAt = prefs[Keys.PAIRED_AT] ?: "",
        )
    }

    suspend fun current(): PhoneConfig = config.first()

    suspend fun savePairing(token: String, address: String, fingerprint: String, pairedAt: String) {
        context.dataStore.edit { prefs ->
            prefs[Keys.TOKEN] = token
            prefs[Keys.HUB_ADDRESS] = address
            prefs[Keys.HUB_FINGERPRINT] = fingerprint
            prefs[Keys.PAIRED_AT] = pairedAt
        }
    }

    suspend fun updateAddress(address: String) {
        context.dataStore.edit { it[Keys.HUB_ADDRESS] = address }
    }

    /** 只允许 0 / 7 / 15 / 30，其他值一律拒绝，与 PROTOCOL.md §7 一致。 */
    suspend fun setRetentionDays(days: Int) {
        require(days in VALID_RETENTION) { "非法保留期: $days" }
        context.dataStore.edit { it[Keys.RETENTION_DAYS] = days }
    }

    suspend fun setServiceEnabled(enabled: Boolean) {
        context.dataStore.edit { it[Keys.SERVICE_ENABLED] = enabled }
    }

    suspend fun clearPairing() {
        context.dataStore.edit { prefs ->
            prefs.remove(Keys.TOKEN)
            prefs.remove(Keys.HUB_ADDRESS)
            prefs.remove(Keys.HUB_FINGERPRINT)
            prefs.remove(Keys.PAIRED_AT)
        }
    }

    companion object {
        val VALID_RETENTION = setOf(0, 7, 15, 30)
    }
}
